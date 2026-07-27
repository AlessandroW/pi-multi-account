/**
 * Cursor is an OPTIONAL provider that lives in a separate repo, on whatever Node the user runs.
 * It must never be able to damage the extension.
 *
 * This was found on a real machine: the cloned `pi-cursor-provider` imports a JSON file in a way
 * newer Node rejects, so loading it threw. That rejection (a) escaped from the fire-and-forget
 * discovery call as an unhandled rejection — which Node can turn into a process exit — and
 * (b) aborted `session_start` partway, skipping the reset that clears a previous session's
 * pending auto-resume. A stale resume surviving into a new session means silently restarting
 * work the user never asked to restart.
 *
 * Runs in a child process on purpose: the cursor bridge caches the loaded provider module, so an
 * in-process test would reuse whatever a previous test loaded.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_ENTRY = join(REPO_ROOT, "index.ts");

const DRIVER = `const agentDir = process.argv[2];
const cursorRoot = process.argv[3];
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CURSOR_PROVIDER_ROOT = cursorRoot;

const rejections = [];
process.on("unhandledRejection", (reason) => {
	rejections.push(String(reason && reason.message ? reason.message : reason));
});

const mod = await import(process.argv[4]);

const events = {};
const notifies = [];
const pi = {
	registerProvider: () => {},
	registerCommand: () => {},
	on: (name, handler) => { events[name] = handler; },
	setModel: async () => true,
	sendUserMessage: () => {},
	continueAgent: async () => {},
	appendEntry: () => {},
	getThinkingLevel: () => "high",
	setThinkingLevel: () => {},
};
const ctx = {
	model: { provider: "anthropic", id: "claude-opus-5" },
	isIdle: () => true,
	signal: { aborted: false },
	hasPendingMessages: () => false,
	ui: { notify: (m) => notifies.push(m), setStatus: () => {} },
	modelRegistry: {
		find: (provider, id) => ({ provider, id }),
		getAll: () => [{ provider: "anthropic", id: "claude-opus-5" }],
		authStorage: { reload: () => {}, hasAuth: () => true },
		getProviderAuthStatus: () => ({ configured: true }),
	},
	getContextUsage: () => undefined,
};

mod.default(pi);
await events.session_start?.({}, ctx);
await new Promise((r) => setTimeout(r, 400));

const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");
let state = {};
try { state = JSON.parse(readFileSync(join(agentDir, "provider-failover-state.json"), "utf8")); } catch {}
let log = [];
try {
	log = readFileSync(join(agentDir, "provider-failover-debug.log"), "utf8")
		.split("\\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
} catch {}

console.log("__RESULT__" + JSON.stringify({
	sessionStartCompleted: notifies.some((m) => m.includes("loaded")),
	pendingFromAfter: state.pendingFrom,
	cursorNotices: notifies.filter((m) => m.includes("Cursor provider at")).length,
	loggedFailure: log.some((e) => e.kind === "cursor_setup_failed"),
	rejections,
}));
`;

function runSession(cursorProviderSource: string | undefined) {
	const agentDir = mkdtempSync(join(tmpdir(), "cursor-opt-"));
	const cursorRoot = join(agentDir, "cursor-provider");
	if (cursorProviderSource !== undefined) {
		mkdirSync(cursorRoot, { recursive: true });
		writeFileSync(join(cursorRoot, "cursor-shared.ts"), cursorProviderSource);
	}
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: "r" } }),
	);
	writeFileSync(
		join(agentDir, "provider-failover.json"),
		JSON.stringify({
			enabled: true,
			includeCursor: true,
			showUsage: false,
			autoDiscoverModels: false,
			fallbacks: [],
		}),
	);
	// A leftover pending auto-resume from a previous session. session_start must clear it.
	writeFileSync(
		join(agentDir, "provider-failover-state.json"),
		JSON.stringify({
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			pendingFrom: "anthropic/claude-opus-5",
			pendingReason: "stale pending resume from a previous session",
			pendingSince: Date.now() - 60_000,
			lastSwitches: [],
		}),
	);

	const driver = join(agentDir, "driver.mjs");
	writeFileSync(driver, DRIVER);
	try {
		const stdout = execFileSync(
			process.execPath,
			[driver, agentDir, cursorRoot, EXTENSION_ENTRY],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
		const line = stdout.split("\n").find((l) => l.startsWith("__RESULT__"));
		assert.ok(line, `driver produced no result. stdout:\n${stdout}`);
		return JSON.parse(line.slice("__RESULT__".length));
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
}

const BROKEN_PROVIDER =
	'throw new Error("cursor-models-raw.json needs an import attribute of \\"type: json\\"");\n';

test("a Cursor provider that fails to load cannot abort session_start", () => {
	const result = runSession(BROKEN_PROVIDER);
	assert.equal(
		result.sessionStartCompleted,
		true,
		"session_start must run to completion despite the cursor failure",
	);
	assert.equal(
		result.pendingFromAfter,
		undefined,
		"a previous session's pending auto-resume must still be cleared",
	);
});

test("a Cursor provider that fails to load never escapes as an unhandled rejection", () => {
	const result = runSession(BROKEN_PROVIDER);
	// Node can terminate the process on an unhandled rejection — this must never reach it.
	assert.deepEqual(result.rejections, []);
});

test("a Cursor provider that fails to load is reported once, not silently swallowed", () => {
	const result = runSession(BROKEN_PROVIDER);
	// The user cloned it deliberately, so silence would be wrong; repeating it on every
	// discovery pass would be nagging. Exactly one notice, plus a black-box log entry.
	assert.equal(result.cursorNotices, 1);
	assert.equal(result.loggedFailure, true);
});

test("no Cursor provider installed stays completely silent", () => {
	const result = runSession(undefined);
	assert.equal(result.sessionStartCompleted, true);
	assert.equal(result.cursorNotices, 0);
	assert.equal(result.loggedFailure, false);
	assert.deepEqual(result.rejections, []);
});
