/**
 * Edge-case tests for pi-multi-account.
 *
 * These drive the REAL extension logic through a mock ExtensionAPI + mock ctx, with an
 * isolated PI_CODING_AGENT_DIR, so every failover/abort/manual-selection/shaping path is
 * exercised without a live Pi. Run: `npm test`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pmacct-test-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

// Import AFTER setting the env so AGENT_DIR (a module const) points at our temp dir.
const { default: piMultiAccount } = (await import("../index.ts")) as { default: (pi: any) => void };

const AUTH = join(AGENT_DIR, "auth.json");
const CONFIG = join(AGENT_DIR, "provider-failover.json");
const STATE = join(AGENT_DIR, "provider-failover-state.json");

type Account = Record<string, { access: string; refresh?: string }>;

const TWO_ACCOUNTS: Account = {
	anthropic: { access: "a-tok-1", refresh: "a-ref-1" },
	"openai-codex-account-2": { access: "c-tok-2", refresh: "c-ref-2" },
};
const ONE_ACCOUNT: Account = { anthropic: { access: "a-tok-1", refresh: "a-ref-1" } };

function setup(opts: {
	accounts?: Account;
	current?: { provider: string; id: string };
	config?: Record<string, unknown>;
	idle?: boolean;
	aborted?: boolean;
}) {
	const accounts = opts.accounts ?? TWO_ACCOUNTS;
	writeFileSync(AUTH, JSON.stringify(accounts));
	writeFileSync(
		CONFIG,
		JSON.stringify({ enabled: true, autoContinue: true, autoDiscover: true, fallbacks: [], ...(opts.config ?? {}) }),
	);
	try {
		rmSync(STATE);
	} catch {
		/* none */
	}

	const known = new Set<string>(Object.keys(accounts));
	const mkModel = (provider: string, id: string) => ({ provider, id });
	const rec = { sent: [] as string[], setModels: [] as string[], notifies: [] as string[] };
	let idle = opts.idle ?? true;

	const ctx: any = {
		model: opts.current ? mkModel(opts.current.provider, opts.current.id) : undefined,
		isIdle: () => idle,
		signal: { aborted: opts.aborted ?? false },
		hasPendingMessages: () => false,
		ui: { notify: (m: string) => rec.notifies.push(m) },
		modelRegistry: {
			find: (p: string, id: string) => (known.has(p) ? mkModel(p, id) : undefined),
			getAll: () => [...known].map((p) => mkModel(p, "claude-opus-4-8")),
		},
	};
	const events: Record<string, (ev: any, c?: any) => any> = {};
	const pi: any = {
		registerProvider: (n: string) => known.add(n),
		registerCommand: () => {},
		on: (e: string, h: any) => {
			events[e] = h;
		},
		setModel: async (m: any) => {
			rec.setModels.push(`${m.provider}/${m.id}`);
			ctx.model = mkModel(m.provider, m.id);
			return true;
		},
		sendUserMessage: (p: string) => rec.sent.push(p),
		appendEntry: () => {},
		getThinkingLevel: () => "high",
		setThinkingLevel: () => {},
	};
	piMultiAccount(pi);

	const fire = async (e: string, ev: any = {}) => events[e]?.(ev, ctx);
	const beforeReq = (payload: unknown) => events.before_provider_request?.({ payload });
	const setIdle = (v: boolean) => {
		idle = v;
	};
	const readState = () => {
		try {
			return JSON.parse(readFileSync(STATE, "utf8"));
		} catch {
			return {};
		}
	};
	return { ctx, rec, fire, beforeReq, setIdle, readState };
}

const limitMsg = (event: any) => ({
	message: { role: "assistant", stopReason: "error", errorMessage: '429 {"type":"rate_limit_error"}' },
	...event,
});

// ---------------------------------------------------------------------------
// Failover core
// ---------------------------------------------------------------------------

test("429 on the current account switches to an available fallback", async () => {
	const t = setup({ current: { provider: "anthropic", id: "claude-opus-4-8" } });
	await t.fire("after_provider_response", { status: 429, headers: {} });
	assert.equal(t.rec.setModels.length, 1, "should switch exactly once");
	assert.match(t.rec.setModels[0], /^openai-codex-account-2\//, "should switch to the other account");
});

test("when every account is rate-limited it STOPS (no churn, no resurrection)", async () => {
	const t = setup({ accounts: ONE_ACCOUNT, current: { provider: "anthropic", id: "claude-opus-4-8" } });
	await t.fire("after_provider_response", { status: 429, headers: {} });
	assert.equal(t.rec.setModels.length, 0, "no account to switch to → must not switch");
	assert.equal(t.rec.sent.length, 0, "must not auto-send anything");
	assert.ok(
		t.rec.notifies.some((m) => /stopped|rate-limited|unavailable/i.test(m)),
		"should notify that it stopped",
	);
});

test("401 marks the account invalid (dead auth) and fails over", async () => {
	const t = setup({ current: { provider: "anthropic", id: "claude-opus-4-8" } });
	await t.fire("after_provider_response", { status: 401, headers: {} });
	assert.equal(t.rec.setModels.length, 1, "should switch off the dead account");
	const st = t.readState();
	assert.ok(st.invalidatedByProvider?.anthropic, "anthropic should be marked invalid in state");
});

test("a non-limit error (context overflow) does NOT trigger failover", async () => {
	const t = setup({ current: { provider: "anthropic", id: "claude-opus-4-8" } });
	await t.fire("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "context window exceeded" }] });
	assert.equal(t.rec.setModels.length, 0);
	assert.equal(t.rec.sent.length, 0);
});

// ---------------------------------------------------------------------------
// User control: Esc / abort
// ---------------------------------------------------------------------------

test("Esc (assistant stopReason 'aborted') stops the chain — no continuation", async () => {
	const t = setup({ current: { provider: "anthropic", id: "claude-opus-4-8" } });
	await t.fire("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
	assert.equal(t.rec.sent.length, 0, "must not continue after an abort");
	assert.equal(t.rec.setModels.length, 0);
});

test("ctx.signal.aborted suppresses failover on a provider error", async () => {
	const t = setup({ current: { provider: "anthropic", id: "claude-opus-4-8" }, aborted: true });
	await t.fire("after_provider_response", { status: 429, headers: {} });
	assert.equal(t.rec.setModels.length, 0, "aborted → no failover");
});

test("no background timers exist (continuation only happens synchronously)", async () => {
	// Drive an all-exhausted stop, then assert nothing is sent on later ticks.
	const t = setup({ accounts: ONE_ACCOUNT, current: { provider: "anthropic", id: "claude-opus-4-8" } });
	await t.fire("after_provider_response", { status: 429, headers: {} });
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(t.rec.sent.length, 0, "nothing should fire on a later tick (no setTimeout resurrection)");
});

// ---------------------------------------------------------------------------
// Manual model selection is respected
// ---------------------------------------------------------------------------

test("manual model pick is respected — a limit does NOT auto-flip the provider", async () => {
	const t = setup({ current: { provider: "anthropic", id: "claude-opus-4-8" } });
	await t.fire("model_select", { model: { provider: "anthropic", id: "claude-opus-4-8" } });
	await t.fire("after_provider_response", { status: 429, headers: {} });
	assert.equal(t.rec.setModels.length, 0, "must stay on the manually-selected provider");
	assert.ok(t.rec.notifies.some((m) => /manual/i.test(m)), "should explain it is staying on the manual pick");
});

test("an automatic failover switch is NOT treated as a manual pin", async () => {
	const t = setup({ current: { provider: "anthropic", id: "claude-opus-4-8" } });
	await t.fire("after_provider_response", { status: 429, headers: {} }); // anthropic -> codex (auto)
	await t.fire("after_provider_response", { status: 429, headers: {} }); // codex limited too -> should try to move again
	// Second 429 on the auto-selected account must still attempt failover (then stop, only 2 accts).
	assert.ok(t.rec.notifies.some((m) => /stopped|rate-limited|unavailable/i.test(m)), "second limit handled, not pinned");
});

test("manual pin is released after a successful response, restoring auto-failover", async () => {
	const t = setup({ current: { provider: "anthropic", id: "claude-opus-4-8" } });
	await t.fire("model_select", { model: { provider: "anthropic", id: "claude-opus-4-8" } });
	await t.fire("after_provider_response", { status: 200, headers: {} }); // success → unpin
	await t.fire("after_provider_response", { status: 429, headers: {} }); // now auto-failover allowed
	assert.equal(t.rec.setModels.length, 1, "after success the pin is released and failover works");
});

// ---------------------------------------------------------------------------
// Idle gating
// ---------------------------------------------------------------------------

test("continuation is skipped while the agent is not idle", async () => {
	const t = setup({ current: { provider: "anthropic", id: "claude-opus-4-8" } });
	await t.fire("after_provider_response", { status: 429, headers: {} }); // switch to codex, currentPromptSwitch set
	t.setIdle(false);
	await t.fire("agent_end", limitMsg({ messages: [{ role: "assistant", stopReason: "error", errorMessage: '429 {"type":"rate_limit_error"}' }] }));
	assert.equal(t.rec.sent.length, 0, "must not send a continuation while busy");
});

// ---------------------------------------------------------------------------
// Anthropic OAuth request shaping (vendored)
// ---------------------------------------------------------------------------

test("shaping: OAuth-marked Anthropic payload gets a billing header, idempotently", async () => {
	const t = setup({ current: { provider: "anthropic", id: "claude-opus-4-8" } });
	const payload = {
		model: "claude-opus-4-8",
		stream: true,
		messages: [{ role: "user", content: "hello world this is a test message" }],
		system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for working." }],
	};
	const once = t.beforeReq(payload) as any;
	assert.ok(Array.isArray(once.system), "system is an array");
	assert.match(once.system[0].text, /^x-anthropic-billing-header:/, "billing header prepended");
	const billingCount = (s: any[]) => s.filter((b) => /x-anthropic-billing-header:/.test(b.text)).length;
	assert.equal(billingCount(once.system), 1);
	const twice = t.beforeReq(once) as any; // idempotent
	assert.equal(billingCount(twice.system), 1, "running shaping twice must not add a second billing header");
});

test("shaping: non-OAuth Anthropic payload is left untouched", async () => {
	const t = setup({ current: { provider: "anthropic", id: "claude-opus-4-8" } });
	const payload = {
		model: "claude-opus-4-8",
		stream: true,
		messages: [{ role: "user", content: "hi" }],
		system: [{ type: "text", text: "Just a normal system prompt with no oauth marker." }],
	};
	const out = t.beforeReq(payload) as any;
	assert.deepEqual(out, payload, "no OAuth marker → payload passes through unchanged");
});

test("shaping: a non-Anthropic-messages payload passes through unchanged", async () => {
	const t = setup({ current: { provider: "anthropic", id: "claude-opus-4-8" } });
	const payload = { foo: "bar" };
	assert.deepEqual(t.beforeReq(payload), payload);
});

// ---------------------------------------------------------------------------
// Session binding
// ---------------------------------------------------------------------------

test("session_shutdown clears pending state and does not throw", async () => {
	const t = setup({ accounts: ONE_ACCOUNT, current: { provider: "anthropic", id: "claude-opus-4-8" } });
	await t.fire("after_provider_response", { status: 429, headers: {} }); // sets a pendingReason
	await t.fire("session_shutdown", {});
	const st = t.readState();
	assert.ok(!st.pendingContinuationPrompt, "no pending continuation should survive shutdown");
});
