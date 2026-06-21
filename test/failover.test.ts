/**
 * State-machine tests for pi-multi-account.
 *
 * The harness drives the real extension in Pi's actual event order:
 * provider responses (possibly retried) -> final assistant message -> agent_end.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pmacct-test-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const { default: piMultiAccount, mergeRefreshedCredentials } = (await import(
	"../index.ts"
)) as {
	default: (pi: any) => void;
	mergeRefreshedCredentials: (credentials: any, refreshed: any) => any;
};

const AUTH = join(AGENT_DIR, "auth.json");
const CONFIG = join(AGENT_DIR, "provider-failover.json");
const STATE = join(AGENT_DIR, "provider-failover-state.json");

type Credential = {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	key?: string;
	accountId?: string;
};
type Account = Record<string, Credential>;

const TWO_ACCOUNTS: Account = {
	anthropic: { type: "oauth", access: "a-tok-1", refresh: "a-ref-1" },
	"openai-codex-account-2": {
		type: "oauth",
		access: "c-tok-2",
		refresh: "c-ref-2",
		accountId: "codex-2",
	},
};
const ONE_ACCOUNT: Account = {
	anthropic: { type: "oauth", access: "a-tok-1", refresh: "a-ref-1" },
};

let messageTimestamp = 1;

function setup(opts: {
	accounts?: Account;
	current?: { provider: string; id: string };
	config?: Record<string, unknown>;
	idle?: boolean;
	aborted?: boolean;
	seedCooldownsMsFromNow?: Record<string, number>;
	seedState?: Record<string, unknown>;
	setModelFailures?: string[];
	forceRefreshResults?: Record<
		string,
		| { status: "refreshed" }
		| { status: "terminal"; error: string }
		| { status: "transient"; error: string }
	>;
}) {
	const accounts = opts.accounts ?? TWO_ACCOUNTS;
	writeFileSync(AUTH, JSON.stringify(accounts));
	writeFileSync(
		CONFIG,
		JSON.stringify({
			enabled: true,
			autoContinue: true,
			autoDiscover: true,
			showUsage: false,
			fallbacks: [],
			...(opts.config ?? {}),
		}),
	);

	if (opts.seedState) {
		writeFileSync(STATE, JSON.stringify(opts.seedState));
	} else if (opts.seedCooldownsMsFromNow) {
		const now = Date.now();
		const exhaustedUntilByProvider: Record<string, number> = {};
		for (const [provider, ms] of Object.entries(opts.seedCooldownsMsFromNow)) {
			exhaustedUntilByProvider[provider] = now + ms;
		}
		writeFileSync(
			STATE,
			JSON.stringify({
				stateVersion: 4,
				exhaustedUntilByProvider,
				lastProbeAtByProvider: {},
				invalidatedByProvider: {},
				lastSwitches: [],
			}),
		);
	} else {
		rmSync(STATE, { force: true });
	}

	const known = new Set<string>(Object.keys(accounts));
	const mkModel = (provider: string, id: string) => ({ provider, id });
	const rec = {
		sent: [] as Array<{ prompt: string; options?: Record<string, unknown> }>,
		setModels: [] as string[],
		notifies: [] as string[],
		statuses: [] as Array<{ key: string; value: string | undefined }>,
		aborts: 0,
		authReloads: 0,
	};
	let idle = opts.idle ?? true;
	const events: Record<string, (event: any, ctx?: any) => any> = {};
	const commands: Record<string, (args: string, ctx: any) => any> = {};

	const ctx: any = {
		model: opts.current
			? mkModel(opts.current.provider, opts.current.id)
			: undefined,
		isIdle: () => idle,
		signal: { aborted: opts.aborted ?? false },
		hasPendingMessages: () => false,
		abort: () => {
			rec.aborts++;
			ctx.signal.aborted = true;
		},
		ui: {
			notify: (message: string) => rec.notifies.push(message),
			setStatus: (key: string, value: string | undefined) =>
				rec.statuses.push({ key, value }),
		},
		modelRegistry: {
			find: (provider: string, id: string) =>
				known.has(provider) ? mkModel(provider, id) : undefined,
			getAll: () =>
				[...known].map((provider) => mkModel(provider, "claude-opus-4-8")),
			authStorage: {
				reload: () => {
					rec.authReloads++;
				},
				forceRefreshProvider: async (provider: string) =>
					opts.forceRefreshResults?.[provider] ?? {
						status: "terminal",
						error: "refresh_token_invalidated: session has ended",
					},
				hasAuth: (provider: string) => {
					const entry = JSON.parse(readFileSync(AUTH, "utf8"))[provider];
					return !!(entry?.key || entry?.access);
				},
			},
			getProviderAuthStatus: (provider: string) => ({
				configured: known.has(provider),
			}),
		},
	};

	const pi: any = {
		registerProvider: (name: string) => known.add(name),
		registerCommand: (
			name: string,
			options: { handler: (args: string, ctx: any) => any },
		) => {
			commands[name] = options.handler;
		},
		on: (event: string, handler: any) => {
			events[event] = handler;
		},
		setModel: async (model: any) => {
			const previousModel = ctx.model;
			const target = `${model.provider}/${model.id}`;
			rec.setModels.push(target);
			if (opts.setModelFailures?.includes(target)) return false;
			ctx.model = mkModel(model.provider, model.id);
			await events.model_select?.(
				{ model: ctx.model, previousModel, source: "set" },
				ctx,
			);
			return true;
		},
		sendUserMessage: (prompt: string, options?: Record<string, unknown>) =>
			rec.sent.push({ prompt, options }),
		appendEntry: () => {},
		getThinkingLevel: () => "high",
		setThinkingLevel: () => {},
	};

	piMultiAccount(pi);

	const fire = async (event: string, payload: any = {}) =>
		events[event]?.(payload, ctx);
	const setIdle = (value: boolean) => {
		idle = value;
	};
	const setCurrent = (provider: string, id: string) => {
		ctx.model = mkModel(provider, id);
	};
	const readState = () => {
		try {
			return JSON.parse(readFileSync(STATE, "utf8"));
		} catch {
			return {};
		}
	};
	const beforeReq = (payload: unknown) =>
		events.before_provider_request?.({ payload }, ctx);
	const command = async (args: string) =>
		commands["multi-account"]?.(args, ctx);
	const input = async (text: string, images?: any[]) =>
		events.input?.({ type: "input", text, images, source: "interactive" }, ctx);

	return {
		ctx,
		rec,
		fire,
		setIdle,
		setCurrent,
		readState,
		beforeReq,
		command,
		input,
	};
}

function wait(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function assistantError(provider: string, model: string, errorMessage: string) {
	return {
		role: "assistant",
		content: [],
		provider,
		model,
		stopReason: "error",
		errorMessage,
		timestamp: messageTimestamp++,
	};
}

async function finishError(
	t: ReturnType<typeof setup>,
	provider: string,
	model: string,
	errorMessage: string,
) {
	const message = assistantError(provider, model, errorMessage);
	await t.fire("message_end", { message });
	await t.fire("agent_end", { messages: [message] });
	return message;
}

// ---------------------------------------------------------------------------
// Usage footer
// ---------------------------------------------------------------------------

test("usage footer countdown refreshes while the session is idle", async () => {
	const provider = "openai-codex-account-2";
	const now = Date.now();
	const t = setup({
		current: { provider, id: "gpt-5.5" },
		config: { showUsage: true, usageStatusRefreshMs: 20 },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			usageByProvider: {
				[provider]: {
					provider,
					family: "codex",
					fetchedAt: now,
					primary: { usedPercent: 1, resetAt: now + 61_000 },
				},
			},
			lastSwitches: [],
		},
	});

	await t.fire("session_start");
	assert.equal(t.rec.statuses.at(-1)?.value, "Codex A2 | 5h 99% left/2m");

	await wait(1_100);
	assert.equal(t.rec.statuses.at(-1)?.value, "Codex A2 | 5h 99% left/1m");
	await t.fire("session_shutdown");
});

// ---------------------------------------------------------------------------
// One final error -> one decision
// ---------------------------------------------------------------------------

test("HTTP retry responses never switch early; one final 429 switches exactly once", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		idle: false,
	});
	await t.fire("agent_start");
	for (let attempt = 0; attempt < 4; attempt++) {
		await t.fire("after_provider_response", {
			status: 429,
			headers: { "retry-after": "60" },
		});
	}
	assert.equal(
		t.rec.setModels.length,
		0,
		"must not mutate the active model while Pi is retrying HTTP",
	);

	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		'429 {"type":"rate_limit_error"}',
	);
	assert.deepEqual(t.rec.setModels, ["openai-codex-account-2/claude-opus-4-8"]);
	assert.equal(
		t.rec.sent.length,
		1,
		"the interrupted task should be continued once",
	);
	assert.deepEqual(
		t.rec.sent[0].options,
		{ deliverAs: "followUp" },
		"agent_end must queue a follow-up while Pi is not idle",
	);
});

test("the failed assistant provider is authoritative even if ctx.model changed", async () => {
	const accounts: Account = {
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
		"openai-codex-account-2": {
			type: "oauth",
			access: "b",
			refresh: "br",
			accountId: "b",
		},
		"openai-codex-account-3": {
			type: "oauth",
			access: "c",
			refresh: "cr",
			accountId: "c",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	t.setCurrent("openai-codex-account-2", "gpt-5.5");
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate_limit_error");
	const state = t.readState();
	assert.ok(
		state.exhaustedUntilByProvider?.anthropic,
		"the provider named by the assistant error is cooled down",
	);
	assert.ok(
		!state.exhaustedUntilByProvider?.["openai-codex-account-2"],
		"the current ctx provider is not falsely blamed",
	);
});

test("a manual model selection does not disable failover for a real limit", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await t.fire("model_select", {
		model: { provider: "anthropic", id: "claude-opus-4-8" },
		previousModel: undefined,
		source: "set",
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	assert.equal(
		t.rec.setModels.length,
		1,
		"a real 429 must still rotate after a manual selection",
	);
});

test("the same final assistant error is handled only once", async () => {
	const t = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { autoContinue: false },
	});
	const message = assistantError(
		"anthropic",
		"claude-opus-4-8",
		"401 authentication_error",
	);
	await t.fire("message_end", { message });
	await t.fire("message_end", { message });
	assert.ok(
		!t.readState().invalidatedByProvider?.anthropic,
		"one event delivered twice must still count as one 401",
	);
});

// ---------------------------------------------------------------------------
// Cooldowns, ordering, and duplicate accounts
// ---------------------------------------------------------------------------

test("picks a fresh account and skips one that is still on cooldown", async () => {
	const accounts: Account = {
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
		"openai-codex-account-2": {
			type: "oauth",
			access: "b",
			refresh: "br",
			accountId: "b",
		},
		"openai-codex-account-3": {
			type: "oauth",
			access: "c",
			refresh: "cr",
			accountId: "c",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedCooldownsMsFromNow: { "openai-codex-account-2": 60 * 60 * 1000 },
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	assert.deepEqual(t.rec.setModels, ["openai-codex-account-3/claude-opus-4-8"]);
});

test("no-fallback warning reports invalidated accounts separately from cooldowns", async () => {
	const deadAccess = "dead-2";
	const deadTokenHash = createHash("sha256")
		.update(deadAccess)
		.digest("hex")
		.slice(0, 12);
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
			"openai-codex-account-2": {
				type: "oauth",
				access: deadAccess,
				refresh: "dead-r",
				accountId: "dead-account",
			},
			"openai-codex-account-3": {
				type: "oauth",
				access: "cooldown-3",
				refresh: "cooldown-r",
				accountId: "cooldown-account",
			},
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: {
			autoContinue: false,
			autoDiscover: false,
			fallbacks: [
				"anthropic",
				"openai-codex-account-2",
				"openai-codex-account-3",
			],
		},
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {
				"openai-codex-account-2": Date.now() + 365 * 24 * 60 * 60 * 1000,
				"openai-codex-account-3": Date.now() + 60 * 60 * 1000,
			},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {
				"openai-codex-account-2": {
					tokenHash: deadTokenHash,
					at: Date.now(),
					reason: "OAuth refresh failed permanently: OpenAI",
				},
			},
			lastSwitches: [],
		},
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	const warning = t.rec.notifies.find((message) =>
		message.includes("no immediately available fallback"),
	);
	assert.ok(warning);
	assert.ok(warning.includes("openai-codex-account-3"));
	assert.ok(warning.includes("Invalidated (need re-login): openai-codex-account-2"));
	assert.ok(!warning.includes("Cooldowns: openai-codex-account-2"));
});

test("same Codex accountId in two slots is one rotation account and shares cooldown", async () => {
	const accounts: Account = {
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
		"openai-codex": {
			type: "oauth",
			access: "base",
			refresh: "base-r",
			accountId: "same-account",
		},
		"openai-codex-account-2": {
			type: "oauth",
			access: "other",
			refresh: "other-r",
			accountId: "other-account",
		},
		"openai-codex-account-3": {
			type: "oauth",
			access: "duplicate",
			refresh: "duplicate-r",
			accountId: "same-account",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "openai-codex", id: "gpt-5.5" },
		config: {
			fallbacks: [
				"openai-codex",
				"openai-codex-account-3",
				"openai-codex-account-2",
				"anthropic",
			],
			autoContinue: false,
		},
	});
	await finishError(t, "openai-codex", "gpt-5.5", "429 usage_limit_reached");
	assert.equal(
		t.rec.setModels[0],
		"openai-codex-account-2/gpt-5.5",
		"duplicate slot must be skipped",
	);
	const state = t.readState();
	assert.ok(state.exhaustedUntilByProvider?.["openai-codex"]);
	assert.ok(
		state.exhaustedUntilByProvider?.["openai-codex-account-3"],
		"all slots for the real account share cooldown",
	);
});

test("session start reports deterministic duplicate account slots", async () => {
	const accounts: Account = {
		"openai-codex": {
			type: "oauth",
			access: "base",
			refresh: "base-r",
			accountId: "same-account",
		},
		"openai-codex-account-2": {
			type: "oauth",
			access: "duplicate",
			refresh: "duplicate-r",
			accountId: "same-account",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "openai-codex", id: "gpt-5.5" },
	});
	await t.fire("session_start", { reason: "startup" });
	assert.ok(
		t.rec.notifies.some((message) =>
			message.includes("openai-codex-account-2 duplicates openai-codex"),
		),
		"the user should be told which redundant slot to replace",
	);
});

test("an activation failure is retried after auth reload, cooled briefly, and skipped", async () => {
	const accounts: Account = {
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
		"openai-codex-account-2": {
			type: "oauth",
			access: "b",
			refresh: "br",
			accountId: "b",
		},
		"openai-codex-account-3": {
			type: "oauth",
			access: "c",
			refresh: "cr",
			accountId: "c",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		setModelFailures: ["openai-codex-account-2/claude-opus-4-8"],
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	assert.deepEqual(t.rec.setModels, [
		"openai-codex-account-2/claude-opus-4-8",
		"openai-codex-account-2/claude-opus-4-8",
		"openai-codex-account-3/claude-opus-4-8",
	]);
	assert.ok(t.readState().exhaustedUntilByProvider?.["openai-codex-account-2"]);
	assert.ok(!t.readState().invalidatedByProvider?.["openai-codex-account-2"]);
});

test("v3 one-year poisoned invalidations are removed during migration", () => {
	const now = Date.now();
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedState: {
			stateVersion: 3,
			exhaustedUntilByProvider: {
				anthropic: now + 60_000,
				"openai-codex-account-2": now + 365 * 24 * 60 * 60 * 1000,
			},
			invalidatedByProvider: {
				"openai-codex-account-2": {
					tokenHash: "old",
					at: now,
					reason: "401 terminated",
				},
			},
		},
	});
	const state = t.readState();
	assert.equal(state.stateVersion, 5);
	assert.ok(
		state.exhaustedUntilByProvider?.anthropic,
		"plausible quota cooldown is retained",
	);
	assert.ok(
		!state.exhaustedUntilByProvider?.["openai-codex-account-2"],
		"one-year poison is removed",
	);
	assert.deepEqual(state.invalidatedByProvider, {});
});

test("re-login clears a persisted invalidation when the slot credential changes", () => {
	const provider = "openai-codex-account-2";
	const oldTokenHash = createHash("sha256")
		.update("old-access")
		.digest("hex")
		.slice(0, 12);
	const t = setup({
		accounts: {
			[provider]: {
				type: "oauth",
				access: "new-access",
				refresh: "new-refresh",
				accountId: "codex-2",
			},
		},
		current: { provider, id: "gpt-5.5" },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {
				[provider]: Date.now() + 365 * 24 * 60 * 60 * 1000,
			},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {
				[provider]: {
					tokenHash: oldTokenHash,
					at: Date.now(),
					reason: "refresh token invalidated",
				},
			},
			lastSwitches: [],
		},
	});
	const state = t.readState();
	assert.ok(!state.invalidatedByProvider?.[provider]);
	assert.ok(!state.exhaustedUntilByProvider?.[provider]);
});

// ---------------------------------------------------------------------------
// Auth failures are counted per final assistant message
// ---------------------------------------------------------------------------

test("one final 401 is counted once, does not invalidate OAuth, and fails over", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	for (let attempt = 0; attempt < 3; attempt++) {
		await t.fire("after_provider_response", { status: 401, headers: {} });
	}
	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		"401 authentication_error",
	);
	const state = t.readState();
	assert.ok(
		!state.invalidatedByProvider?.anthropic,
		"one request must not become three auth failures",
	);
	assert.equal(
		t.rec.setModels.length,
		1,
		"the current task should continue on another account",
	);
});

test("an explicitly invalidated OAuth token is removed immediately and failover continues", async () => {
	const accounts: Account = {
		"openai-codex-account-2": {
			type: "oauth",
			access: "dead-2",
			refresh: "refresh-2",
			accountId: "codex-2",
		},
		"openai-codex-account-4": {
			type: "oauth",
			access: "live-4",
			refresh: "refresh-4",
			accountId: "codex-4",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		config: {
			autoContinue: false,
			autoDiscover: false,
			fallbacks: [
				"openai-codex-account-2",
				"openai-codex-account-4",
				"anthropic",
			],
		},
	});
	await finishError(
		t,
		"openai-codex-account-2",
		"gpt-5.5",
		"Your authentication token has been invalidated. Please try signing in again.",
	);
	assert.ok(t.readState().invalidatedByProvider?.["openai-codex-account-2"]);
	assert.deepEqual(t.rec.setModels, ["openai-codex-account-4/gpt-5.5"]);
	assert.ok(
		t.rec.notifies.some(
			(message) =>
				message.includes("Run /login") &&
				message.includes("openai-codex-account-2"),
		),
	);
});

test("an early-invalidated access token is force-refreshed and retried on the same account", async () => {
	const accounts: Account = {
		"openai-codex-account-2": {
			type: "oauth",
			access: "stale-2",
			refresh: "working-refresh-2",
			accountId: "codex-2",
		},
		"openai-codex-account-4": {
			type: "oauth",
			access: "live-4",
			refresh: "refresh-4",
			accountId: "codex-4",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		forceRefreshResults: { "openai-codex-account-2": { status: "refreshed" } },
	});
	await finishError(
		t,
		"openai-codex-account-2",
		"gpt-5.5",
		"Your authentication token has been invalidated. Please try signing in again.",
	);
	assert.deepEqual(
		t.rec.setModels,
		[],
		"a successful refresh must stay on the same account",
	);
	assert.equal(
		t.rec.sent.length,
		1,
		"the interrupted task should retry once with the refreshed token",
	);
	assert.ok(!t.readState().invalidatedByProvider?.["openai-codex-account-2"]);
	assert.ok(
		t.rec.notifies.some((message) =>
			message.includes("refreshed successfully"),
		),
	);
});

test("a temporary forced-refresh failure cools the slot without permanently invalidating it", async () => {
	const accounts: Account = {
		"openai-codex-account-2": {
			type: "oauth",
			access: "stale-2",
			refresh: "working-refresh-2",
			accountId: "codex-2",
		},
		"openai-codex-account-4": {
			type: "oauth",
			access: "live-4",
			refresh: "refresh-4",
			accountId: "codex-4",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		config: { autoContinue: false },
		forceRefreshResults: {
			"openai-codex-account-2": {
				status: "transient",
				error: "network timeout",
			},
		},
	});
	await finishError(
		t,
		"openai-codex-account-2",
		"gpt-5.5",
		"Your authentication token has been invalidated. Please try signing in again.",
	);
	assert.ok(!t.readState().invalidatedByProvider?.["openai-codex-account-2"]);
	assert.ok(t.readState().exhaustedUntilByProvider?.["openai-codex-account-2"]);
	assert.deepEqual(t.rec.setModels, ["openai-codex-account-4/gpt-5.5"]);
});

test("a second account failure in the same agent chain is not hidden by the previous switch", async () => {
	const accounts: Account = {
		"openai-codex-account-2": {
			type: "oauth",
			access: "dead-2",
			refresh: "refresh-2",
			accountId: "codex-2",
		},
		"openai-codex-account-4": {
			type: "oauth",
			access: "dead-4",
			refresh: "refresh-4",
			accountId: "codex-4",
		},
		anthropic: { type: "oauth", access: "live-a", refresh: "refresh-a" },
	};
	const t = setup({
		accounts,
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		config: {
			autoContinue: false,
			autoDiscover: false,
			fallbacks: [
				"openai-codex-account-2",
				"openai-codex-account-4",
				"anthropic",
			],
		},
	});
	const error =
		"Your authentication token has been invalidated. Please try signing in again.";
	await t.fire("message_end", {
		message: assistantError("openai-codex-account-2", "gpt-5.5", error),
	});
	await t.fire("message_end", {
		message: assistantError("openai-codex-account-4", "gpt-5.5", error),
	});
	assert.deepEqual(t.rec.setModels, [
		"openai-codex-account-4/gpt-5.5",
		"anthropic/gpt-5.5",
	]);
	assert.ok(t.readState().invalidatedByProvider?.["openai-codex-account-2"]);
	assert.ok(t.readState().invalidatedByProvider?.["openai-codex-account-4"]);
});

test("rotated (refreshed) tokens 401ing past the threshold invalidate a refreshable account", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { autoContinue: false },
	});
	// MAX_CONSECUTIVE_AUTH_FAILURES is 8 in v1.9.0+. Each attempt rotates the access token
	// (simulating Pi refreshing and the NEW token still failing) — distinct refreshed tokens
	// advance the kill counter. Below the threshold the account must stay alive.
	for (let attempt = 0; attempt < 7; attempt++) {
		writeFileSync(
			AUTH,
			JSON.stringify({
				anthropic: {
					type: "oauth",
					access: `a-tok-${attempt}`,
					refresh: "a-ref-1",
				},
			}),
		);
		t.setCurrent("anthropic", "claude-opus-4-8");
		await t.fire("agent_start");
		await finishError(
			t,
			"anthropic",
			"claude-opus-4-8",
			"401 authentication_error",
		);
	}
	assert.ok(
		!t.readState().invalidatedByProvider?.anthropic,
		"seven rotated-token 401s must NOT invalidate (threshold is 8)",
	);
	// One more rotated-token failure crosses the threshold → invalidate.
	writeFileSync(
		AUTH,
		JSON.stringify({
			anthropic: {
				type: "oauth",
				access: `a-tok-7`,
				refresh: "a-ref-1",
			},
		}),
	);
	t.setCurrent("anthropic", "claude-opus-4-8");
	await t.fire("agent_start");
	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		"401 authentication_error",
	);
	assert.ok(t.readState().invalidatedByProvider?.anthropic);
});

test("repeated 401s on the SAME unrefreshed token never permanently invalidate", async () => {
	// Reproduces the alias-refresh bug class: the access token never changes between 401s because the
	// refresh isn't reaching the wire. The account must stay recoverable, not be killed-until-relogin.
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { autoContinue: false },
	});
	for (let attempt = 0; attempt < 5; attempt++) {
		t.setCurrent("anthropic", "claude-opus-4-8");
		await t.fire("agent_start");
		await finishError(
			t,
			"anthropic",
			"claude-opus-4-8",
			"401 authentication_error",
		);
	}
	assert.ok(
		!t.readState().invalidatedByProvider?.anthropic,
		"a static unrefreshed token must not be mistaken for a revoked account",
	);
});

test("a successful response resets the 401 streak", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { autoContinue: false },
	});
	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		"401 authentication_error",
	);
	t.setCurrent("anthropic", "claude-opus-4-8");
	await t.fire("after_provider_response", { status: 200, headers: {} });
	for (let attempt = 0; attempt < 2; attempt++) {
		t.setCurrent("anthropic", "claude-opus-4-8");
		await t.fire("agent_start");
		await finishError(
			t,
			"anthropic",
			"claude-opus-4-8",
			"401 authentication_error",
		);
	}
	assert.ok(!t.readState().invalidatedByProvider?.anthropic);
});

test("a non-limit error does not trigger failover", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		"context window exceeded",
	);
	assert.equal(t.rec.setModels.length, 0);
	assert.equal(t.rec.sent.length, 0);
});

test("the per-task auto-continue cap survives the extension's own follow-up", async () => {
	const accounts: Account = {
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
		"openai-codex-account-2": {
			type: "oauth",
			access: "b",
			refresh: "br",
			accountId: "b",
		},
		"openai-codex-account-3": {
			type: "oauth",
			access: "c",
			refresh: "cr",
			accountId: "c",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { maxAutoContinuesPerPrompt: 1 },
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	assert.equal(t.rec.sent.length, 1);

	await t.fire("before_agent_start", { prompt: t.rec.sent[0].prompt });
	await t.fire("agent_start");
	await finishError(
		t,
		"openai-codex-account-2",
		"claude-opus-4-8",
		"429 rate limit",
	);
	assert.equal(
		t.rec.sent.length,
		1,
		"the second failure must stop instead of creating another follow-up",
	);
	assert.equal(
		t.rec.setModels.length,
		1,
		"the cap must prevent another automatic account switch",
	);
});

test("dead authorization with no fallback does not leave fake pending work", async () => {
	const t = setup({
		accounts: { anthropic: { type: "api_key", key: "dead-key" } },
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "401 invalid api key");
	assert.ok(t.readState().invalidatedByProvider?.anthropic);
	assert.ok(!t.readState().pendingContinuationPrompt);
});

test("manual next can override cooldowns without arming an automatic continuation", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedCooldownsMsFromNow: { "openai-codex-account-2": 60 * 60 * 1000 },
	});
	await t.command("next");
	assert.deepEqual(t.rec.setModels, ["openai-codex-account-2/claude-opus-4-8"]);
	await t.fire("agent_end", { messages: [] });
	assert.equal(
		t.rec.sent.length,
		0,
		"manual account selection must not enqueue extension work",
	);
});

test("slash commands bypass the cooldown input queue", async () => {
	const t = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedCooldownsMsFromNow: { anthropic: 60 * 60 * 1000 },
	});
	const result = await t.input("/login");
	assert.deepEqual(result, { action: "continue" });
	assert.ok(
		!t.rec.notifies.some((message) => message.includes("held in memory")),
	);
	assert.equal(t.rec.sent.length, 0);
});

// ---------------------------------------------------------------------------
// User control and session-bound automatic resume
// ---------------------------------------------------------------------------

test("Esc abort stops the chain and clears pending resume", async () => {
	const t = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	const message = assistantError(
		"anthropic",
		"claude-opus-4-8",
		"429 rate limit",
	);
	await t.fire("message_end", { message });
	assert.ok(t.readState().pendingContinuationPrompt);
	await t.fire("agent_end", {
		messages: [{ role: "assistant", stopReason: "aborted" }],
	});
	assert.equal(t.rec.sent.length, 0);
	assert.ok(!t.readState().pendingContinuationPrompt);
	await new Promise((resolve) => setTimeout(resolve, 1100));
	assert.equal(
		t.rec.sent.length,
		0,
		"cancelled timer must not resurrect the task",
	);
});

test("all-limited work resumes in the same live session after cooldown", async () => {
	const t = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { cooldownMs: 1000, probeCooldownMs: 1000 },
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	assert.equal(t.rec.sent.length, 0, "nothing is available immediately");
	assert.ok(t.readState().pendingContinuationPrompt);
	await new Promise((resolve) => setTimeout(resolve, 1200));
	assert.equal(
		t.rec.sent.length,
		1,
		"the task resumes once the account cooldown expires",
	);
	assert.ok(!t.readState().pendingContinuationPrompt);
});

test("session shutdown cancels pending work permanently", async () => {
	const t = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { cooldownMs: 1000 },
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	await t.fire("session_shutdown", { reason: "quit" });
	await new Promise((resolve) => setTimeout(resolve, 1100));
	assert.equal(t.rec.sent.length, 0);
	assert.ok(!t.readState().pendingContinuationPrompt);
});

test("a cooled account stays skipped after its OAuth access token refreshes", async () => {
	const accounts: Account = {
		anthropic: { type: "oauth", access: "a-tok", refresh: "a-ref" },
		"openai-codex-account-2": {
			type: "oauth",
			access: "c-old",
			refresh: "c-ref",
			accountId: "codex-2",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedCooldownsMsFromNow: { "openai-codex-account-2": 60 * 60 * 1000 },
	});
	await t.fire("session_start");
	t.rec.setModels.length = 0;
	// Pi rotates the OAuth access token in place — same real account (same accountId).
	writeFileSync(
		AUTH,
		JSON.stringify({
			...accounts,
			"openai-codex-account-2": {
				type: "oauth",
				access: "c-NEW",
				refresh: "c-ref",
				accountId: "codex-2",
			},
		}),
	);
	await t.command("rediscover");
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	assert.deepEqual(
		t.rec.setModels,
		[],
		"a routine token refresh must not wipe a still-active rate-limit cooldown",
	);
	assert.ok(
		t.readState().pendingContinuationPrompt,
		"both accounts cooling → pending resume armed",
	);
});

test("manual next cycles through every account instead of ping-ponging between two", async () => {
	const accounts: Account = {
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
		"anthropic-account-2": { type: "oauth", access: "a2", refresh: "a2r" },
		"openai-codex-account-2": {
			type: "oauth",
			access: "b",
			refresh: "br",
			accountId: "b",
		},
		"openai-codex-account-4": {
			type: "oauth",
			access: "d",
			refresh: "dr",
			accountId: "d",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		// All cooling, codex soonest — exactly the shape from the real failure logs.
		seedCooldownsMsFromNow: {
			anthropic: 4 * 60 * 60 * 1000,
			"anthropic-account-2": 3 * 60 * 60 * 1000,
			"openai-codex-account-2": 4 * 60 * 60 * 1000,
			"openai-codex-account-4": 2 * 60 * 60 * 1000,
		},
	});
	await t.fire("session_start");
	const providers: string[] = [];
	for (let i = 0; i < 4; i++) {
		await t.command("next");
		providers.push(t.ctx.model.provider);
	}
	assert.ok(
		providers.some((p) => p.startsWith("anthropic")),
		`next must reach an anthropic slot; visited=${providers.join(",")}`,
	);
	assert.ok(
		new Set(providers).size >= 3,
		`next must visit >=3 distinct accounts; visited=${providers.join(",")}`,
	);
});

test("resume fires on whichever account recovers first, not rotation order", async () => {
	const accounts: Account = {
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
		"openai-codex-account-2": {
			type: "oauth",
			access: "b",
			refresh: "br",
			accountId: "b",
		},
	};
	// codex-2 (rotation slot 1) recovers FIRST; anthropic is the failed model, cooled long.
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedCooldownsMsFromNow: { "openai-codex-account-2": 1000 },
	});
	await t.fire("session_start");
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	assert.ok(t.readState().pendingContinuationPrompt, "pending must be armed");
	await wait(1400);
	assert.equal(t.rec.sent.length, 1, "work resumes when codex-2 recovers first");
	assert.equal(
		t.rec.setModels.at(-1),
		"openai-codex-account-2/claude-opus-4-8",
		"resume on the first-recovered account",
	);
});

test("a long over-estimated cooldown is corrected by fresh usage and resumes", async () => {
	const now = Date.now();
	const t = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { pendingPollMs: 150 },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			// Fresh usage says the 5h window is empty — the account is actually free again.
			usageByProvider: {
				anthropic: {
					provider: "anthropic",
					family: "anthropic",
					fetchedAt: now,
					primary: { usedPercent: 0, resetAt: now - 1000 },
				},
			},
			lastSwitches: [],
		},
	});
	await t.fire("session_start");
	// 429 with no reset hint → recorded cooldown defaults to a long (6h) estimate.
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	assert.ok(
		t.readState().pendingContinuationPrompt,
		"pending armed (recorded cooldown is hours)",
	);
	// Without reconciliation this would sleep ~6h; usage shows recovery, so the next poll resumes.
	await wait(450);
	assert.equal(
		t.rec.sent.length,
		1,
		"must resume once fresh usage shows the account recovered",
	);
});

// ---------------------------------------------------------------------------
// Anthropic OAuth request shaping
// ---------------------------------------------------------------------------

test("OAuth-marked Anthropic payload gets one billing header", () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	const payload = {
		model: "claude-opus-4-8",
		stream: true,
		messages: [{ role: "user", content: "hello world this is a test message" }],
		system: [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for working.",
			},
		],
	};
	const once = t.beforeReq(payload) as any;
	assert.match(once.system[0].text, /^x-anthropic-billing-header:/);
	assert.match(once.system[0].text, /cc_version=2\.1\.172\./);
	const billingCount = (system: any[]) =>
		system.filter((block) => /x-anthropic-billing-header:/.test(block.text))
			.length;
	assert.equal(billingCount(once.system), 1);
	assert.equal(
		billingCount((t.beforeReq(once) as any).system),
		1,
		"shaping is idempotent",
	);
});

test("non-OAuth Anthropic payload is unchanged", () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	const payload = {
		model: "claude-opus-4-8",
		stream: true,
		messages: [{ role: "user", content: "hi" }],
		system: [{ type: "text", text: "Normal system prompt." }],
	};
	assert.deepEqual(t.beforeReq(payload), payload);
});

// ---------------------------------------------------------------------------
// OAuth refresh merge — the base provider and aliases must share this logic so a
// refreshed access token is never silently dropped (which 401s an account to death).
// ---------------------------------------------------------------------------

test("a refresh replaces the stale access token (not just the refresh token)", () => {
	const merged = mergeRefreshedCredentials(
		{ type: "oauth", access: "STALE", refresh: "OLD-R", expires: 1 },
		{ access: "FRESH", refresh: "NEW-R", expires: 2 },
	);
	assert.equal(
		merged.access,
		"FRESH",
		"the refreshed access token must win — dropping it 401s forever",
	);
	assert.equal(merged.refresh, "NEW-R");
	assert.equal(merged.expires, 2);
});

test("a refresh keeps the old refresh token when the provider mints no new one", () => {
	const merged = mergeRefreshedCredentials(
		{ type: "oauth", access: "STALE", refresh: "KEEP-ME" },
		{ access: "FRESH", refresh: "   " },
	);
	assert.equal(merged.access, "FRESH");
	assert.equal(
		merged.refresh,
		"KEEP-ME",
		"a blank refresh from the provider must not wipe the working one",
	);
});

// ---------------------------------------------------------------------------
// v1.9.0 regressions:
//  - invalidated accounts no longer carry a 365-day cooldown entry
//  - /multi-account revive restores an account to rotation
//  - api_key providers (Ollama, Alibaba) survive a transient 401 without being
//    killed for a year (only terminal auth patterns invalidate immediately)
//  - Ollama/Alibaba alias slots (ollama-account-2, alibaba-account-2) are
//    discovered and join the rotation just like OAuth alias slots.
// ---------------------------------------------------------------------------

test("invalidation no longer writes a 365-day cooldown entry", async () => {
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { autoContinue: false },
	});
	// Force a terminal invalidation: "invalid api key" matches TERMINAL_AUTH_ERROR_PATTERNS.
	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		"invalid api key",
	);
	assert.ok(t.readState().invalidatedByProvider?.anthropic);
	// The cooldown map must NOT contain an ~365-day entry for the invalidated account.
	const until = t.readState().exhaustedUntilByProvider?.anthropic;
	assert.ok(
		until === undefined,
		`invalidation must not pollute cooldowns (found ${until})`,
	);
});

test("/multi-account revive restores an invalidated account to rotation", async () => {
	const accounts = {
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
		"openai-codex-account-2": {
			type: "oauth",
			access: "live-2",
			refresh: "refresh-2",
			accountId: "codex-2",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: {
			autoContinue: false,
			autoDiscover: true,
			fallbacks: ["anthropic", "openai-codex-account-2"],
		},
	});
	// Kill anthropic with a terminal pattern.
	await finishError(t, "anthropic", "claude-opus-4-8", "invalid api key");
	assert.ok(t.readState().invalidatedByProvider?.anthropic);
	// Revive it.
	await t.command("revive anthropic");
	assert.ok(
		!t.readState().invalidatedByProvider?.anthropic,
		"revive must clear the invalidation",
	);
});

test("an api_key provider's bare 401 is transient, not a year-long kill", async () => {
	const accounts = {
		ollama: { type: "api_key", key: "ollama-key" },
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
	};
	const t = setup({
		accounts,
		current: { provider: "ollama", id: "glm-5.2:cloud" },
		config: {
			autoContinue: false,
			autoDiscover: true,
			fallbacks: ["ollama", "anthropic"],
		},
	});
	// A transient 401 (not "invalid api key", just "401 unauthorized") must NOT
	// immediately invalidate an api_key slot.
	await finishError(t, "ollama", "glm-5.2:cloud", "401 unauthorized");
	assert.ok(
		!t.readState().invalidatedByProvider?.ollama,
		"a bare 401 on an api_key provider must not kill it for a year",
	);
	// It SHOULD be on a short transient cooldown so selection skips it briefly.
	const until = t.readState().exhaustedUntilByProvider?.ollama ?? 0;
	assert.ok(
		until > Date.now() && until - Date.now() < 60_000,
		"api_key transient cooldown should be brief (sub-minute)",
	);
});

test("Ollama alias slots (ollama-account-2) join the rotation", async () => {
	const accounts = {
		ollama: { type: "api_key", key: "k1" },
		"ollama-account-2": { type: "api_key", key: "k2" },
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
	};
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: {
			autoDiscover: true,
			fallbacks: ["anthropic", "ollama", "ollama-account-2"],
		},
	});
	await t.fire("session_start", { reason: "startup" });
	// The startup notify reports "<N> account(s) in rotation" — with ollama +
	// ollama-account-2 + anthropic all authed, N must be 3.
	const startup = t.rec.notifies.find((m) =>
		m.includes("account(s) in rotation"),
	);
	assert.ok(startup, "session_start must report rotation size");
	assert.ok(
		/3 account\(s\) in rotation/.test(startup),
		`expected 3 accounts in rotation, got: ${startup}`,
	);
	// And a real failover lands on an ollama-family provider.
	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		"429 rate_limit_error",
	);
	const switchedToOllama = t.rec.setModels.some((m) =>
		m.startsWith("ollama") || m.startsWith("ollama-account-"),
	);
	assert.ok(
		switchedToOllama,
		"a 429 on anthropic must fail over to an ollama-family slot",
	);
});

test("Alibaba/Qwen alias slots (alibaba-account-2) join the rotation", async () => {
	const accounts = {
		alibaba: { type: "api_key", key: "k1" },
		"alibaba-account-2": { type: "api_key", key: "k2" },
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
	};
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: {
			autoDiscover: true,
			fallbacks: ["anthropic", "alibaba", "alibaba-account-2"],
		},
	});
	await t.fire("session_start", { reason: "startup" });
	const startup = t.rec.notifies.find((m) =>
		m.includes("account(s) in rotation"),
	);
	assert.ok(startup, "session_start must report rotation size");
	assert.ok(
		/3 account\(s\) in rotation/.test(startup),
		`expected 3 accounts in rotation, got: ${startup}`,
	);
	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		"429 rate_limit_error",
	);
	const switchedToQwen = t.rec.setModels.some((m) =>
		m.startsWith("alibaba") || m.startsWith("alibaba-account-"),
	);
	assert.ok(
		switchedToQwen,
		"a 429 on anthropic must fail over to an alibaba/qwen-family slot",
	);
});
