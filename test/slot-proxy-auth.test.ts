/**
 * Numbered OAuth slots cannot keep the subscription token in the file a child reads.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PROXY_PLACEHOLDER_JWT, PROXY_PLACEHOLDER_KEY } from "../slot-proxy.ts";
import { CURSOR_PROXY_PLACEHOLDER_KEY } from "../cursor-bridge.ts";
import {
	applyRestoreAll,
	applyRestorePlan,
	applyShadowAll,
	applyShadowPlan,
	childFacingAuthEntry,
	isChildFacingPlaceholder,
	mergeParentAuth,
	needsAuthShadow,
	type AuthBlob,
} from "../slot-proxy-auth.ts";

const oauth: AuthBlob = {
	type: "oauth",
	access: "access-token",
	refresh: "refresh-token",
	accountId: "acct",
};

test("a numbered Anthropic slot is shadowed to the published placeholder", () => {
	const step = applyShadowPlan("anthropic-account-2", { "anthropic-account-2": oauth }, {});
	assert.equal(step.changed, true);
	assert.equal(step.auth["anthropic-account-2"]?.type, "api_key");
	assert.equal(step.auth["anthropic-account-2"]?.key, PROXY_PLACEHOLDER_KEY);
	assert.equal(step.sidecar["anthropic-account-2"]?.access, "access-token");
	assert.equal(step.sidecar["anthropic-account-2"]?.refresh, "refresh-token");
});

test("a numbered Codex slot uses the JWT-shaped placeholder Pi will parse", () => {
	const step = applyShadowPlan("openai-codex-account-4", { "openai-codex-account-4": oauth }, {});
	assert.equal(step.changed, true);
	assert.equal(step.auth["openai-codex-account-4"]?.key, PROXY_PLACEHOLDER_JWT);
	assert.equal(isChildFacingPlaceholder(step.auth["openai-codex-account-4"], "codex"), true);
});

test("base Anthropic is not shadowed: the child still presents OAuth to the loopback", () => {
	const step = applyShadowPlan("anthropic", { anthropic: oauth }, {});
	assert.equal(step.changed, false);
	assert.equal(step.auth.anthropic?.type, "oauth");
	assert.equal(step.sidecar.anthropic, undefined);
});

test("restore writes the OAuth blob back and clears the sidecar", () => {
	const shadowed = applyShadowPlan("anthropic-account-2", { "anthropic-account-2": oauth }, {});
	const restored = applyRestorePlan(
		"anthropic-account-2",
		shadowed.auth,
		shadowed.sidecar,
	);
	assert.equal(restored.changed, true);
	assert.deepEqual(restored.auth["anthropic-account-2"], oauth);
	assert.equal(restored.sidecar["anthropic-account-2"], undefined);
});

test("a re-login that already restored OAuth to auth.json drops the stale sidecar copy", () => {
	const restored = applyRestorePlan(
		"anthropic-account-2",
		{ "anthropic-account-2": oauth },
		{ "anthropic-account-2": { type: "oauth", access: "stale" } },
	);
	assert.equal(restored.changed, true);
	assert.equal(restored.auth["anthropic-account-2"]?.access, "access-token");
	assert.equal(restored.sidecar["anthropic-account-2"], undefined);
});

test("the parent still sees OAuth while the child-facing file shows the placeholder", () => {
	const shadowed = applyShadowPlan("anthropic-account-2", { "anthropic-account-2": oauth }, {});
	const parent = mergeParentAuth(shadowed.auth, shadowed.sidecar);
	assert.equal(parent["anthropic-account-2"]?.type, "oauth");
	assert.equal(parent["anthropic-account-2"]?.access, "access-token");
	assert.equal(shadowed.auth["anthropic-account-2"]?.type, "api_key");
});

test("shadowing many slots leaves unrelated credentials alone", () => {
	const step = applyShadowAll(
		["anthropic-account-2", "openai-codex-account-4", "anthropic", "zai"],
		{
			"anthropic-account-2": oauth,
			"openai-codex-account-4": oauth,
			anthropic: oauth,
			zai: { type: "api_key", key: "sk-real" },
		},
		{},
	);
	assert.equal(step.changed, true);
	assert.equal(step.auth.anthropic?.type, "oauth");
	assert.equal(step.auth.zai?.key, "sk-real");
	assert.equal(step.auth["anthropic-account-2"]?.type, "api_key");
	assert.equal(step.auth["openai-codex-account-4"]?.key, PROXY_PLACEHOLDER_JWT);
	const restored = applyRestoreAll(step.auth, step.sidecar);
	assert.equal(restored.auth["anthropic-account-2"]?.type, "oauth");
	assert.equal(restored.auth["openai-codex-account-4"]?.type, "oauth");
	assert.equal(Object.keys(restored.sidecar).length, 0);
});

test("the Anthropic placeholder is not a JWT and the Codex one is", () => {
	assert.equal(childFacingAuthEntry("anthropic").key, PROXY_PLACEHOLDER_KEY);
	assert.notEqual(childFacingAuthEntry("codex").key, PROXY_PLACEHOLDER_KEY);
	assert.equal(childFacingAuthEntry("codex").key?.includes("."), true);
});

test("base Cursor is shadowed to the cursor-proxy placeholder, unlike base Anthropic", () => {
	assert.equal(needsAuthShadow("cursor"), true);
	assert.equal(needsAuthShadow("cursor-account-2"), true);
	assert.equal(needsAuthShadow("anthropic"), false);
	const step = applyShadowPlan("cursor", { cursor: oauth }, {});
	assert.equal(step.changed, true);
	assert.equal(step.auth.cursor?.type, "api_key");
	assert.equal(step.auth.cursor?.key, CURSOR_PROXY_PLACEHOLDER_KEY);
	assert.equal(step.sidecar.cursor?.access, "access-token");
	const parent = mergeParentAuth(step.auth, step.sidecar);
	assert.equal(parent.cursor?.type, "oauth");
	const restored = applyRestorePlan("cursor", step.auth, step.sidecar);
	assert.deepEqual(restored.auth.cursor, oauth);
});
