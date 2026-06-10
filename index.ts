/**
 * pi-multi-account — automatic multi-account failover & rotation for Pi.
 *
 * What it does
 * ------------
 * - Auto-discovers every authenticated account from ~/.pi/agent/auth.json
 *   (Anthropic Claude Pro/Max, OpenAI/ChatGPT Codex, and Qwen/Alibaba) and
 *   builds the failover rotation dynamically — no manual config editing.
 * - Pre-registers a pool of login slots so you can simply run
 *   `/login anthropic-account-3` (or `openai-codex-account-5`) to add an
 *   account; the next discovery sweep adds it to the rotation automatically.
 * - Drops an account from the rotation the moment its token is expired or its
 *   authorization is revoked, and restores it automatically once you re-login.
 * - On a quota/rate-limit (429/402/403) it marks the account on cooldown and
 *   transparently switches to the next available account/model, optionally
 *   queuing a safe continuation prompt.
 *
 * Anthropic OAuth (Claude Pro/Max) works out of the box: this package enables
 * OAuth login on the base `anthropic` provider and on every `anthropic-account-*`
 * alias, and shapes the outgoing requests itself (billing header + system-prompt
 * normalization, vendored from gotgenes/pi-anthropic-auth, MIT). No separate
 * pi-anthropic-auth install is needed; if you have one, both coexist (idempotent).
 *
 * Config:  ~/.pi/agent/provider-failover.json
 * State:   ~/.pi/agent/provider-failover-state.json
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";
import { loginAnthropic, openaiCodexOAuthProvider, refreshAnthropicToken } from "@earendil-works/pi-ai/oauth";

type ModelRef = `${string}/${string}`;
type ProviderFamily = "anthropic" | "openai-codex" | "qwen";

type OpenAICodexAliasConfig = { id: string; displayName?: string; models?: string[] };
type AnthropicOAuthAliasConfig = { id: string; displayName?: string; models?: string[] };

type ProviderFailoverConfig = {
	enabled?: boolean;
	autoContinue?: boolean;
	autoDiscover?: boolean;
	maxAccountsPerProvider?: number;
	includeQwen?: boolean;
	qwenProvider?: string;
	providerOrder?: ProviderFamily[];
	cooldownMs?: number;
	probeCooldownMs?: number;
	invalidCooldownMs?: number;
	maxAutoContinuesPerPrompt?: number;
	fallbacks?: string[];
	openaiCodexAliases?: OpenAICodexAliasConfig[];
	anthropicOAuthAliases?: AnthropicOAuthAliasConfig[];
	limitErrorPatterns?: string[];
	authErrorPatterns?: string[];
	ignoreErrorPatterns?: string[];
	continuationPrompt?: string;
};

type RuntimeConfig = Required<
	Pick<
		ProviderFailoverConfig,
		| "enabled"
		| "autoContinue"
		| "autoDiscover"
		| "maxAccountsPerProvider"
		| "includeQwen"
		| "qwenProvider"
		| "providerOrder"
		| "cooldownMs"
		| "probeCooldownMs"
		| "invalidCooldownMs"
		| "maxAutoContinuesPerPrompt"
		| "fallbacks"
		| "limitErrorPatterns"
		| "authErrorPatterns"
		| "ignoreErrorPatterns"
		| "continuationPrompt"
	>
> & {
	openaiCodexAliases: OpenAICodexAliasConfig[];
	anthropicOAuthAliases: AnthropicOAuthAliasConfig[];
};

type SwitchRecord = { from: ModelRef; to: ModelRef; reason: string; at: number };

type InvalidationRecord = { tokenHash: string; at: number; reason: string };

type ProviderFailoverState = {
	stateVersion?: number;
	exhaustedUntilByProvider?: Record<string, number>;
	lastProbeAtByProvider?: Record<string, number>;
	invalidatedByProvider?: Record<string, InvalidationRecord>;
	pendingContinuationPrompt?: string;
	pendingSince?: number;
	pendingReason?: string;
	lastSwitches?: SwitchRecord[];
};

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "provider-failover.json");
const STATE_PATH = join(AGENT_DIR, "provider-failover-state.json");
const AUTH_PATH = join(AGENT_DIR, "auth.json");
const STATE_VERSION = 3;
const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const DEFAULT_PROBE_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_INVALID_COOLDOWN_MS = 365 * 24 * 60 * 60 * 1000; // effectively "until re-login"
// Runaway-loop guards (added). Without these, when every account is rate-limited the
// failover bounces between accounts every 1-9s forever, growing the session history
// until the machine swaps itself to death.
const ANTI_PINGPONG_MS = 60 * 1000; // don't switch straight back to the account we just left
const MIN_AUTOCONTINUE_INTERVAL_MS = 15 * 1000; // floor between auto-continuations (CPU/network guard)

const ANTHROPIC_BASE = "anthropic";
const CODEX_BASE = "openai-codex";
const DEFAULT_QWEN_PROVIDER = "alibaba";

const DEFAULT_LIMIT_PATTERNS = [
	"429",
	"rate limit",
	"rate_limit",
	"too many requests",
	"usage limit",
	"usage_limit_reached",
	"usage_not_included",
	"quota",
	"insufficient_quota",
	"out of budget",
	"available balance",
	"billing hard limit",
	"monthly usage limit",
	"freeusagelimiterror",
	"gousagelimiterror",
];

// Errors that mean "this account's authorization is dead" → drop from rotation
// until the user re-logs in (not a temporary cooldown).
const DEFAULT_AUTH_ERROR_PATTERNS = [
	"401",
	"unauthorized",
	"authentication_error",
	"invalid authentication",
	"invalid_token",
	"invalid token",
	"token has expired",
	"token expired",
	"expired token",
	"invalid_grant",
	"invalid api key",
	"incorrect api key",
	"no api key",
	"missing api key",
	"revoked",
	"oauth token",
];

const DEFAULT_IGNORE_PATTERNS = [
	"context overflow",
	"context window",
	"context length",
	"maximum context",
	"too many tokens",
	"token limit exceeded",
	"input is too long",
];

const DEFAULT_CONTINUATION_PROMPT = [
	"Provider failover activated: the previous provider/account hit a quota or rate limit, and Pi switched to {to}.",
	"Continue the interrupted user task from the last safe point.",
	"Do not repeat destructive actions or duplicate completed work. If state is uncertain, inspect current files/session state first, then continue.",
].join(" ");

const DEFAULT_PROVIDER_ORDER: ProviderFamily[] = ["anthropic", "openai-codex", "qwen"];

const CODEX_MODEL_DEFS: Record<string, Record<string, unknown>> = {
	"gpt-5.3-codex-spark": {
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
		input: ["text"],
		cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
	},
	"gpt-5.4": {
		id: "gpt-5.4",
		name: "GPT-5.4",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
		input: ["text", "image"],
		cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
	"gpt-5.4-mini": {
		id: "gpt-5.4-mini",
		name: "GPT-5.4 mini",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
		input: ["text", "image"],
		cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
	"gpt-5.5": {
		id: "gpt-5.5",
		name: "GPT-5.5",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
		input: ["text", "image"],
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
};

const DEFAULT_CODEX_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"];
const DEFAULT_ANTHROPIC_MODELS = ["claude-opus-4-8", "claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"];

const DEFAULT_CONFIG: ProviderFailoverConfig = {
	enabled: true,
	autoContinue: true,
	autoDiscover: true,
	maxAccountsPerProvider: 10,
	includeQwen: true,
	qwenProvider: DEFAULT_QWEN_PROVIDER,
	providerOrder: DEFAULT_PROVIDER_ORDER,
	cooldownMs: DEFAULT_COOLDOWN_MS,
	probeCooldownMs: DEFAULT_PROBE_COOLDOWN_MS,
	invalidCooldownMs: DEFAULT_INVALID_COOLDOWN_MS,
	maxAutoContinuesPerPrompt: 8,
	fallbacks: [],
	openaiCodexAliases: [],
	anthropicOAuthAliases: [],
	limitErrorPatterns: DEFAULT_LIMIT_PATTERNS,
	authErrorPatterns: DEFAULT_AUTH_ERROR_PATTERNS,
	ignoreErrorPatterns: DEFAULT_IGNORE_PATTERNS,
	continuationPrompt: DEFAULT_CONTINUATION_PROMPT,
};

// ---------------------------------------------------------------------------
// Config + state persistence
// ---------------------------------------------------------------------------

function ensureDefaultConfig() {
	if (existsSync(CONFIG_PATH)) return;
	mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
}

function positiveOr(value: unknown, fallback: number) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeConfig(raw: ProviderFailoverConfig): RuntimeConfig {
	const order = Array.isArray(raw.providerOrder) && raw.providerOrder.length > 0 ? raw.providerOrder : DEFAULT_PROVIDER_ORDER;
	return {
		enabled: raw.enabled ?? true,
		autoContinue: raw.autoContinue ?? true,
		autoDiscover: raw.autoDiscover ?? true,
		maxAccountsPerProvider: Math.max(1, Math.floor(positiveOr(raw.maxAccountsPerProvider, 10))),
		includeQwen: raw.includeQwen ?? true,
		qwenProvider: raw.qwenProvider?.trim() || DEFAULT_QWEN_PROVIDER,
		providerOrder: order.filter((f): f is ProviderFamily => f === "anthropic" || f === "openai-codex" || f === "qwen"),
		cooldownMs: positiveOr(raw.cooldownMs, DEFAULT_COOLDOWN_MS),
		probeCooldownMs: positiveOr(raw.probeCooldownMs, DEFAULT_PROBE_COOLDOWN_MS),
		invalidCooldownMs: positiveOr(raw.invalidCooldownMs, DEFAULT_INVALID_COOLDOWN_MS),
		maxAutoContinuesPerPrompt: Math.floor(positiveOr(raw.maxAutoContinuesPerPrompt, 8)),
		fallbacks: Array.isArray(raw.fallbacks) ? raw.fallbacks : [],
		openaiCodexAliases: Array.isArray(raw.openaiCodexAliases) ? raw.openaiCodexAliases : [],
		anthropicOAuthAliases: Array.isArray(raw.anthropicOAuthAliases) ? raw.anthropicOAuthAliases : [],
		limitErrorPatterns: Array.isArray(raw.limitErrorPatterns) && raw.limitErrorPatterns.length > 0 ? raw.limitErrorPatterns : DEFAULT_LIMIT_PATTERNS,
		authErrorPatterns: Array.isArray(raw.authErrorPatterns) && raw.authErrorPatterns.length > 0 ? raw.authErrorPatterns : DEFAULT_AUTH_ERROR_PATTERNS,
		ignoreErrorPatterns: Array.isArray(raw.ignoreErrorPatterns) && raw.ignoreErrorPatterns.length > 0 ? raw.ignoreErrorPatterns : DEFAULT_IGNORE_PATTERNS,
		continuationPrompt: raw.continuationPrompt?.trim() || DEFAULT_CONTINUATION_PROMPT,
	};
}

function loadConfig(): RuntimeConfig {
	ensureDefaultConfig();
	try {
		return normalizeConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as ProviderFailoverConfig);
	} catch {
		return normalizeConfig(DEFAULT_CONFIG);
	}
}

function loadState(): ProviderFailoverState {
	try {
		if (!existsSync(STATE_PATH)) return { stateVersion: STATE_VERSION };
		const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as ProviderFailoverState;
		if (state.stateVersion !== STATE_VERSION) {
			// Preserve invalidations across upgrades; drop stale cooldowns.
			return { stateVersion: STATE_VERSION, invalidatedByProvider: state.invalidatedByProvider ?? {} };
		}
		return state;
	} catch {
		return { stateVersion: STATE_VERSION };
	}
}

function saveState(state: ProviderFailoverState) {
	mkdirSync(dirname(STATE_PATH), { recursive: true, mode: 0o700 });
	writeFileSync(STATE_PATH, `${JSON.stringify({ stateVersion: STATE_VERSION, ...state }, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
}

// ---------------------------------------------------------------------------
// auth.json reading, account identity & token validity
// ---------------------------------------------------------------------------

type AuthEntry = { type?: string; access?: string; refresh?: string; key?: string };

function readAuthFile(): Record<string, AuthEntry> {
	try {
		return JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Record<string, AuthEntry>;
	} catch {
		return {};
	}
}

function authMtimeMs(): number {
	try {
		return statSync(AUTH_PATH).mtimeMs;
	} catch {
		return 0;
	}
}

function decodeJwtPayload(token: string): any | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		let payload = parts[1].replaceAll("-", "+").replaceAll("_", "/");
		payload += "=".repeat((4 - (payload.length % 4)) % 4);
		return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
	} catch {
		return undefined;
	}
}

function jwtExpMs(token: string): number | undefined {
	const exp = decodeJwtPayload(token)?.exp;
	return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
}

function getCodexAccountIdFromAccessToken(token: string): string | undefined {
	return decodeJwtPayload(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id as string | undefined;
}

function hash12(input: string) {
	return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

/** A stable fingerprint of the current credential, used to detect re-login. */
function credentialHash(entry: AuthEntry): string | undefined {
	const secret = entry.access ?? entry.key;
	return secret ? hash12(secret) : undefined;
}

/** Identity used to dedupe the same real account logged into multiple slots. */
function accountIdentity(entry: AuthEntry): string | undefined {
	if (entry.access) {
		const codexId = getCodexAccountIdFromAccessToken(entry.access);
		if (codexId) return `codex:${hash12(codexId)}`;
		return `tok:${hash12(entry.access)}`;
	}
	if (entry.key) return `key:${hash12(entry.key)}`;
	return undefined;
}

/** True when the credential is present and not provably dead. */
function isEntryUsable(entry: AuthEntry | undefined): boolean {
	if (!entry) return false;
	if (entry.type === "api_key" || entry.key) return typeof entry.key === "string" && entry.key.length > 0;
	if (typeof entry.access !== "string" || entry.access.length === 0) return false;
	// Expired access token with no refresh token → unrecoverable.
	const expMs = jwtExpMs(entry.access);
	if (expMs !== undefined && expMs <= Date.now() && !(typeof entry.refresh === "string" && entry.refresh.length > 0)) {
		return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Provider id helpers
// ---------------------------------------------------------------------------

function classifyProvider(id: string, qwenProvider: string): ProviderFamily | undefined {
	if (id === ANTHROPIC_BASE || /^anthropic-account-\d+$/.test(id)) return "anthropic";
	if (id === CODEX_BASE || /^openai-codex-account-\d+$/.test(id)) return "openai-codex";
	if (id === qwenProvider || /^qwen/i.test(id)) return "qwen";
	return undefined;
}

function slotIndex(id: string): number {
	const m = id.match(/-account-(\d+)$/);
	return m ? Number(m[1]) : 1; // base provider counts as slot 1
}

function slotId(family: "anthropic" | "openai-codex", index: number): string {
	const base = family === "anthropic" ? ANTHROPIC_BASE : CODEX_BASE;
	return index <= 1 ? base : `${base}-account-${index}`;
}

function ref(provider: string, modelId: string): ModelRef {
	return `${provider}/${modelId}` as ModelRef;
}

function parseTarget(target: string): { provider: string; modelId?: string } | undefined {
	const trimmed = target.trim();
	if (!trimmed) return undefined;
	const slash = trimmed.indexOf("/");
	if (slash === -1) return { provider: trimmed };
	const provider = trimmed.slice(0, slash).trim();
	const modelId = trimmed.slice(slash + 1).trim();
	if (!provider || !modelId) return undefined;
	return { provider, modelId };
}

// ---------------------------------------------------------------------------
// Model definitions for registered alias providers
// ---------------------------------------------------------------------------

function anthropicModelDef(id: string, providerId: string) {
	const canonical = getModel("anthropic", id as any) as any;
	if (canonical) return { ...canonical, provider: providerId };
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: providerId,
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

function codexModelDef(id: string) {
	return (
		CODEX_MODEL_DEFS[id] ?? {
			id,
			name: id,
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
			input: ["text", "image"],
			contextWindow: 272000,
			maxTokens: 128000,
		}
	);
}

function registerAnthropicSlot(pi: ExtensionAPI, id: string) {
	if (id === ANTHROPIC_BASE) return; // base provider: oauth + shaping registered in piMultiAccount()
	const models = DEFAULT_ANTHROPIC_MODELS.map((m) => anthropicModelDef(m, id));
	pi.registerProvider(id, {
		name: `Claude Pro/Max (${id})`,
		baseUrl: "https://api.anthropic.com",
		api: "anthropic-messages" as any,
		oauth: {
			name: `Claude Pro/Max (${id})`,
			login: (callbacks: any) => loginAnthropic(callbacks),
			async refreshToken(credentials: any) {
				const refreshed = await refreshAnthropicToken(credentials.refresh);
				return {
					...credentials,
					refresh:
						typeof refreshed.refresh === "string" && refreshed.refresh.trim().length > 0 ? refreshed.refresh : credentials.refresh,
				};
			},
			getApiKey: (credentials: any) => credentials.access,
		},
		models: models as any,
	});
}

function registerCodexSlot(pi: ExtensionAPI, id: string) {
	if (id === CODEX_BASE) return; // base provider is native
	const models = DEFAULT_CODEX_MODELS.map(codexModelDef);
	pi.registerProvider(id, {
		name: `ChatGPT Plus/Pro (Codex ${id})`,
		baseUrl: "https://chatgpt.com/backend-api",
		api: "openai-codex-responses" as any,
		oauth: {
			name: `ChatGPT Plus/Pro (Codex ${id})`,
			login: openaiCodexOAuthProvider.login,
			refreshToken: openaiCodexOAuthProvider.refreshToken,
			getApiKey: openaiCodexOAuthProvider.getApiKey,
		},
		models: models as any,
	});
}

// ---------------------------------------------------------------------------
// Misc helpers (cooldown parsing from headers / error bodies)
// ---------------------------------------------------------------------------

function patternMatch(text: string, patterns: string[]) {
	const lower = text.toLowerCase();
	return patterns.some((p) => p && lower.includes(p.toLowerCase()));
}

function retryAfterToMs(value: string | undefined) {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
	const dateMs = Date.parse(value);
	if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
	return undefined;
}

function secondsToMs(value: string | undefined) {
	if (!value) return undefined;
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : undefined;
}

function unixSecondsToCooldownMs(value: string | undefined) {
	if (!value) return undefined;
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds > 0 ? Math.max(0, seconds * 1000 - Date.now()) : undefined;
}

function firstDefinedMs(values: Array<number | undefined>) {
	return values.find((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0);
}

function percentValue(value: string | undefined) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : undefined;
}

function cooldownFromHeaders(headers: Record<string, string>) {
	const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
	const get = (name: string) => normalized.get(name.toLowerCase());
	const primaryUsed = percentValue(get("x-codex-primary-used-percent"));
	const secondaryUsed = percentValue(get("x-codex-secondary-used-percent"));
	const retryAfter = retryAfterToMs(get("retry-after"));
	const primaryReset = firstDefinedMs([secondsToMs(get("x-codex-primary-reset-after-seconds")), unixSecondsToCooldownMs(get("x-codex-primary-reset-at"))]);
	const secondaryReset = firstDefinedMs([secondsToMs(get("x-codex-secondary-reset-after-seconds")), unixSecondsToCooldownMs(get("x-codex-secondary-reset-at"))]);
	if ((secondaryUsed ?? 0) >= 100) return secondaryReset ?? retryAfter ?? primaryReset;
	if ((primaryUsed ?? 0) >= 100) return primaryReset ?? retryAfter ?? secondaryReset;
	return retryAfter ?? primaryReset ?? secondaryReset;
}

function cooldownFromErrorText(errorText: string) {
	const bodyReset = firstDefinedMs([
		secondsToMs(errorText.match(/"resets_in_seconds"\s*:\s*(\d+)/i)?.[1]),
		unixSecondsToCooldownMs(errorText.match(/"resets_at"\s*:\s*(\d+)/i)?.[1]),
	]);
	if (bodyReset !== undefined) return bodyReset;
	const primaryUsed = percentValue(errorText.match(/"X-Codex-Primary-Used-Percent"\s*:\s*"?(\d+)/i)?.[1]);
	const secondaryUsed = percentValue(errorText.match(/"X-Codex-Secondary-Used-Percent"\s*:\s*"?(\d+)/i)?.[1]);
	const primaryReset = firstDefinedMs([
		secondsToMs(errorText.match(/"X-Codex-Primary-Reset-After-Seconds"\s*:\s*"?(\d+)/i)?.[1]),
		unixSecondsToCooldownMs(errorText.match(/"X-Codex-Primary-Reset-At"\s*:\s*"?(\d+)/i)?.[1]),
	]);
	const secondaryReset = firstDefinedMs([
		secondsToMs(errorText.match(/"X-Codex-Secondary-Reset-After-Seconds"\s*:\s*"?(\d+)/i)?.[1]),
		unixSecondsToCooldownMs(errorText.match(/"X-Codex-Secondary-Reset-At"\s*:\s*"?(\d+)/i)?.[1]),
	]);
	if ((secondaryUsed ?? 0) >= 100) return secondaryReset ?? primaryReset;
	if ((primaryUsed ?? 0) >= 100) return primaryReset ?? secondaryReset;
	return primaryReset ?? secondaryReset;
}

function formatUntil(timestamp: number) {
	const ms = timestamp - Date.now();
	if (ms <= 0) return "expired";
	const minutes = Math.ceil(ms / 60000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** stopReason of the most recent assistant message — "aborted" means the user pressed Esc. */
function lastAssistantStopReason(messages: any[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") return messages[i]?.stopReason as string | undefined;
	}
	return undefined;
}

function getAssistantErrorText(messages: any[]) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const error = typeof message.errorMessage === "string" ? message.errorMessage : "";
		if (error) return error;
		if (message.stopReason === "error") {
			return Array.isArray(message.content)
				? message.content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n")
				: "";
		}
	}
	return "";
}

// ===========================================================================
// Anthropic OAuth request shaping (vendored)
//
// Makes Claude Pro/Max (OAuth) accounts work out of the box — no separate
// pi-anthropic-auth install required. Ported from gotgenes/pi-anthropic-auth
// (MIT). The logic is idempotent: if pi-anthropic-auth is ALSO installed, both
// before_provider_request hooks run, but the second sees the request already
// shaped (billing header present, Pi preamble already replaced) and no-ops.
//
// CLAUDE_CODE_VERSION must track the current Claude Code release; if it drifts
// too far Anthropic may reject or miscount OAuth requests. Check `claude
// --version` or https://github.com/anthropics/claude-code.
// ===========================================================================

const PI_DEFAULT_PROMPT_PREFIX = "You are an expert coding assistant operating inside pi, a coding agent harness.";
const PI_DEFAULT_PROMPT_TERMINATOR =
	"- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";
const MINIMAL_ANTHROPIC_OAUTH_PROMPT_PREFIX = "You are an expert coding assistant.";
const MINIMAL_ANTHROPIC_OAUTH_PROMPT = [
	MINIMAL_ANTHROPIC_OAUTH_PROMPT_PREFIX,
	"Be concise and helpful.",
	"Use the available tools to answer the user's request.",
	"Show file paths clearly when working with files.",
].join("\n");
const CLAUDE_CODE_IDENTITY_PREFIX = "You are Claude Code, Anthropic's official CLI";
const CLAUDE_CODE_VERSION = "2.1.150";
const BILLING_HEADER_SALT = "59cf53e54c78";
const BILLING_HEADER_POSITIONS = [4, 7, 20] as const;
const CLAUDE_CODE_ENTRYPOINT = "sdk-cli";
const PARAGRAPH_REMOVAL_ANCHORS: readonly string[] = [
	"operating inside pi, a coding agent harness",
	"In addition to the tools above",
	"Pi documentation (read only when the user asks about pi itself",
];
const TEXT_REPLACEMENTS: readonly { match: string; replacement: string }[] = [
	{
		match: "Here is some useful information about the environment you are running in:",
		replacement: "Environment context you are running in:",
	},
];

type ShapeTextBlock = { type: "text"; text: string; [key: string]: unknown };
type ShapeMessageBlock = { type?: string; text?: string; [key: string]: unknown };
type ShapeMessageParam = { role?: string; content?: string | ShapeMessageBlock[]; [key: string]: unknown };
type ShapeAnthropicPayload = { model?: unknown; messages?: unknown; system?: unknown; stream?: unknown; [key: string]: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAnthropicMessagesPayload(payload: unknown): payload is ShapeAnthropicPayload {
	return isRecord(payload) && typeof payload.model === "string" && Array.isArray(payload.messages) && typeof payload.stream === "boolean";
}

function hasOAuthAnthropicSystemMarker(block: unknown): boolean {
	if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return false;
	return (
		block.text.includes(CLAUDE_CODE_IDENTITY_PREFIX) ||
		block.text.includes("x-anthropic-billing-header:") ||
		block.text.startsWith(MINIMAL_ANTHROPIC_OAUTH_PROMPT_PREFIX)
	);
}

// Only requests that Pi already marked as OAuth (Claude Code identity block, or
// already-shaped) are touched — API-key Anthropic requests pass through untouched.
function isOAuthAnthropicPayload(payload: ShapeAnthropicPayload): boolean {
	if (!Array.isArray(payload.system)) return false;
	return payload.system.some(hasOAuthAnthropicSystemMarker);
}

function getFirstUserText(messages: ShapeMessageParam[]): string {
	const firstUserMessage = messages.find((message) => message.role === "user");
	if (!firstUserMessage) return "";
	if (typeof firstUserMessage.content === "string") return firstUserMessage.content;
	if (!Array.isArray(firstUserMessage.content)) return "";
	const firstTextBlock = firstUserMessage.content.find((block) => block.type === "text" && typeof block.text === "string");
	return typeof firstTextBlock?.text === "string" ? firstTextBlock.text : "";
}

function buildBillingHeaderValue(messages: ShapeMessageParam[]): string | undefined {
	const messageText = getFirstUserText(messages);
	if (!messageText) return undefined;
	const cch = createHash("sha256").update(messageText).digest("hex").slice(0, 5);
	const sampledCharacters = BILLING_HEADER_POSITIONS.map((index) => messageText[index] || "0").join("");
	const suffix = createHash("sha256")
		.update(`${BILLING_HEADER_SALT}${sampledCharacters}${CLAUDE_CODE_VERSION}`)
		.digest("hex")
		.slice(0, 3);
	return ["x-anthropic-billing-header:", `cc_version=${CLAUDE_CODE_VERSION}.${suffix};`, `cc_entrypoint=${CLAUDE_CODE_ENTRYPOINT};`, `cch=${cch};`].join(" ");
}

function normalizeSystemBlock(block: unknown): ShapeTextBlock {
	if (typeof block === "string") return { type: "text", text: block };
	if (isRecord(block) && typeof block.text === "string") return { ...block, type: "text", text: block.text };
	return { type: "text", text: "" };
}

function prependBillingHeader(system: unknown, messages: ShapeMessageParam[]): unknown {
	const billingHeader = buildBillingHeaderValue(messages);
	if (!billingHeader) return system;
	const systemBlocks = Array.isArray(system) ? system.map(normalizeSystemBlock) : system == null ? [] : [normalizeSystemBlock(system)];
	// Idempotent: don't add a second billing header (e.g. pi-anthropic-auth also ran).
	if (systemBlocks.some((block) => block.text.includes("x-anthropic-billing-header:"))) return systemBlocks;
	const billingBlock: ShapeTextBlock = { type: "text", text: billingHeader };
	return [billingBlock, ...systemBlocks];
}

// The Anthropic API rejects assistant turns where non-tool_use blocks follow a
// tool_use block; Pi's serializer can produce that, so split into two turns.
function splitAssistantToolUseTrailingContent(messages: ShapeMessageParam[]): ShapeMessageParam[] {
	return messages.flatMap((message) => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) return [message];
		const firstToolUseIndex = message.content.findIndex((block) => block.type === "tool_use");
		if (firstToolUseIndex === -1) return [message];
		const trailingBlocks = message.content.slice(firstToolUseIndex);
		if (!trailingBlocks.some((block) => block.type !== "tool_use")) return [message];
		const nonToolUseBlocks = message.content.filter((block) => block.type !== "tool_use");
		const toolUseBlocks = message.content.filter((block) => block.type === "tool_use");
		return [
			{ ...message, content: nonToolUseBlocks },
			{ ...message, content: toolUseBlocks },
		];
	});
}

function sanitizeSystemText(text: string): string {
	const paragraphs = text.split(/\n\n+/);
	const filtered = paragraphs.filter((paragraph) => !PARAGRAPH_REMOVAL_ANCHORS.some((anchor) => paragraph.includes(anchor)));
	let result = filtered.join("\n\n");
	for (const rule of TEXT_REPLACEMENTS) result = result.replaceAll(rule.match, rule.replacement);
	return result.trim();
}

function findProjectContextStart(systemPrompt: string): number {
	return systemPrompt.indexOf("\n\n# Project Context\n\n");
}

function shapeAnthropicOAuthSystemPrompt(systemPrompt: string): string {
	const prefixIdx = systemPrompt.indexOf(PI_DEFAULT_PROMPT_PREFIX);
	if (prefixIdx === -1) return systemPrompt;
	const terminatorIdx = systemPrompt.indexOf(PI_DEFAULT_PROMPT_TERMINATOR, prefixIdx);
	if (terminatorIdx !== -1) {
		const terminatorEnd = terminatorIdx + PI_DEFAULT_PROMPT_TERMINATOR.length;
		const preamble = systemPrompt.slice(prefixIdx, terminatorEnd);
		const sanitized = sanitizeSystemText(preamble);
		const shapedPreamble = sanitized ? `${MINIMAL_ANTHROPIC_OAUTH_PROMPT}\n\n${sanitized}` : MINIMAL_ANTHROPIC_OAUTH_PROMPT;
		return systemPrompt.slice(0, prefixIdx) + shapedPreamble + systemPrompt.slice(terminatorEnd);
	}
	// Pi reworded its preamble terminator → fall back to slicing from project context.
	const projectContextStart = findProjectContextStart(systemPrompt);
	if (projectContextStart === -1) return MINIMAL_ANTHROPIC_OAUTH_PROMPT;
	return `${MINIMAL_ANTHROPIC_OAUTH_PROMPT}${systemPrompt.slice(projectContextStart)}`;
}

function shapeSystemBlocks(blocks: ShapeTextBlock[]): ShapeTextBlock[] {
	return blocks.map((block) => {
		if (block.type !== "text" || !block.text.includes(PI_DEFAULT_PROMPT_PREFIX)) return block;
		return { ...block, text: shapeAnthropicOAuthSystemPrompt(block.text) };
	});
}

/** before_provider_request shaper: makes Claude Pro/Max OAuth requests acceptable. */
function shapeAnthropicOAuthPayload(payload: unknown): unknown {
	if (!isAnthropicMessagesPayload(payload)) return payload;
	const messages = payload.messages as ShapeMessageParam[];
	if (!isOAuthAnthropicPayload(payload)) return payload; // API-key / non-OAuth → untouched
	const normalizedMessages = splitAssistantToolUseTrailingContent(messages);
	const shapedSystem = Array.isArray(payload.system) ? shapeSystemBlocks(payload.system as ShapeTextBlock[]) : payload.system;
	const finalSystem = prependBillingHeader(shapedSystem, normalizedMessages);
	return { ...payload, messages: normalizedMessages, system: finalSystem };
}

/** OAuth override enabling Claude Pro/Max login on a provider (base or alias). */
const anthropicOAuthOverride = {
	name: "Anthropic (Claude Pro/Max)",
	login: (callbacks: any) => loginAnthropic(callbacks),
	async refreshToken(credentials: any) {
		const refreshed = await refreshAnthropicToken(credentials.refresh);
		return {
			...credentials,
			...refreshed,
			refresh: typeof refreshed.refresh === "string" && refreshed.refresh.trim().length > 0 ? refreshed.refresh : credentials.refresh,
		};
	},
	getApiKey: (credentials: any) => credentials.access,
};

// ===========================================================================
// Extension entry point
// ===========================================================================

export default function piMultiAccount(pi: ExtensionAPI) {
	let config = loadConfig();
	let persistedState = loadState();

	const exhaustedUntilByProvider = new Map<string, number>(Object.entries(persistedState.exhaustedUntilByProvider ?? {}));
	const invalidatedByProvider = new Map<string, InvalidationRecord>(Object.entries(persistedState.invalidatedByProvider ?? {}));

	// Discovered, authed, deduped provider ids in rotation order.
	let rotation: string[] = [];
	// Slot ids registered as login targets (so /login <id> works).
	const registeredSlots = new Set<string>();
	let lastAuthMtime = -1;

	let currentPromptSwitch: SwitchRecord | undefined;
	// Number of auto-continuations issued for the CURRENT task. Crucially this is NOT
	// reset by the self-triggered re-prompts failover issues (only by a genuine new user
	// prompt — see before_agent_start), so config.maxAutoContinuesPerPrompt actually bounds
	// the failover loop instead of resetting to 0 on every iteration.
	let autoContinuesThisPrompt = 0;
	let lastErrorText = "";
	let latestCtx: any | undefined;
	let pendingWakeTimer: ReturnType<typeof setTimeout> | undefined;
	// --- runaway-loop & user-interrupt guards (added) ---
	let expectingSelfContinuation = false; // true between our sendUserMessage and its agent_start
	let lastSentContinuationPrompt = ""; // secondary check to recognise our own re-prompt
	let userAbortedChain = false; // user pressed Esc → stop auto-continuing until a new prompt
	let lastAutoContinueAt = 0; // for minimum spacing between auto-continuations
	let autoContinueTimer: ReturnType<typeof setTimeout> | undefined; // pending spaced continuation
	let lastLeftProvider: string | undefined; // account we just failed away from (anti-ping-pong)
	let lastLeftAt = 0;
	// The thinking level the user intended for this turn. pi.setModel() re-clamps and
	// persists the thinking level on every model switch, so without this it drifts
	// downward across failovers ("thinking level keeps dropping"). We capture it before
	// any switch and re-assert it after each successful switch.
	let desiredThinkingLevel: any;

	function captureDesiredThinking() {
		try {
			const level = (pi as any).getThinkingLevel?.();
			if (level) desiredThinkingLevel = level;
		} catch {
			/* getThinkingLevel may be unavailable on older Pi — degrade gracefully */
		}
	}

	function restoreDesiredThinking() {
		if (!desiredThinkingLevel) return;
		try {
			(pi as any).setThinkingLevel?.(desiredThinkingLevel);
		} catch {
			/* setThinkingLevel clamps to model caps; ignore if unsupported */
		}
	}

	function persist(extra?: Partial<ProviderFailoverState>) {
		persistedState = {
			...persistedState,
			...extra,
			stateVersion: STATE_VERSION,
			exhaustedUntilByProvider: Object.fromEntries(exhaustedUntilByProvider.entries()),
			invalidatedByProvider: Object.fromEntries(invalidatedByProvider.entries()),
		};
		saveState(persistedState);
	}

	function lastProbeMap() {
		return persistedState.lastProbeAtByProvider ?? {};
	}

	function setLastProbe(provider: string) {
		persistedState = { ...persistedState, lastProbeAtByProvider: { ...lastProbeMap(), [provider]: Date.now() } };
		persist();
	}

	// ----- invalidation (dead authorization) --------------------------------

	function clearReauthedInvalidations(auth: Record<string, AuthEntry>) {
		let changed = false;
		for (const [provider, record] of [...invalidatedByProvider.entries()]) {
			const entry = auth[provider];
			const currentHash = entry ? credentialHash(entry) : undefined;
			// Re-login (credential changed) or entry removed → clear invalidation.
			if (!entry || (currentHash && currentHash !== record.tokenHash)) {
				invalidatedByProvider.delete(provider);
				changed = true;
			}
		}
		if (changed) persist();
	}

	function markInvalid(provider: string, reason: string) {
		const entry = readAuthFile()[provider];
		const tokenHash = entry ? credentialHash(entry) ?? "" : "";
		invalidatedByProvider.set(provider, { tokenHash, at: Date.now(), reason });
		// Also keep a long cooldown so in-flight selection logic skips it immediately.
		exhaustedUntilByProvider.set(provider, Date.now() + config.invalidCooldownMs);
		persist();
	}

	function isInvalidated(provider: string) {
		return invalidatedByProvider.has(provider);
	}

	// ----- cooldowns --------------------------------------------------------

	function pruneCooldowns() {
		const now = Date.now();
		let changed = false;
		for (const [provider, until] of exhaustedUntilByProvider) {
			if (until <= now && !isInvalidated(provider)) {
				exhaustedUntilByProvider.delete(provider);
				changed = true;
			}
		}
		if (changed) persist();
	}

	function providersSharingAccount(provider: string): string[] {
		const auth = readAuthFile();
		const identity = auth[provider] ? accountIdentity(auth[provider]) : undefined;
		if (!identity) return [provider];
		const shared = rotation.filter((p) => {
			const e = auth[p];
			return e && accountIdentity(e) === identity;
		});
		return shared.length > 0 ? shared : [provider];
	}

	function markExhausted(provider: string, cooldownMs: number) {
		const until = Date.now() + Math.max(cooldownMs, 1000);
		for (const candidate of providersSharingAccount(provider)) {
			exhaustedUntilByProvider.set(candidate, Math.max(exhaustedUntilByProvider.get(candidate) ?? 0, until));
		}
		persist();
	}

	// ----- discovery & dynamic rotation -------------------------------------

	function discoverRotation(auth: Record<string, AuthEntry>): string[] {
		const byFamily: Record<ProviderFamily, string[]> = { anthropic: [], "openai-codex": [], qwen: [] };
		for (const [id, entry] of Object.entries(auth)) {
			const family = classifyProvider(id, config.qwenProvider);
			if (!family) continue;
			if (family === "qwen" && !config.includeQwen) continue;
			if (!isEntryUsable(entry)) continue;
			if (isInvalidated(id)) continue;
			byFamily[family].push(id);
		}
		// Sort each family base-first, then account-2,3,... and dedupe real accounts.
		const order = config.providerOrder.length ? config.providerOrder : DEFAULT_PROVIDER_ORDER;
		const seenIdentity = new Set<string>();
		const result: string[] = [];
		for (const family of order) {
			const ids = byFamily[family].sort((a, b) => slotIndex(a) - slotIndex(b));
			for (const id of ids) {
				const identity = accountIdentity(auth[id]);
				if (identity && seenIdentity.has(identity)) continue; // same account in two slots
				if (identity) seenIdentity.add(identity);
				result.push(id);
			}
		}
		return result;
	}

	/** Register authed alias slots plus one spare per family for the next /login. */
	function syncRegisteredSlots(auth: Record<string, AuthEntry>) {
		for (const family of ["anthropic", "openai-codex"] as const) {
			const authedIndexes = Object.keys(auth)
				.filter((id) => classifyProvider(id, config.qwenProvider) === family && isEntryUsable(auth[id]))
				.map(slotIndex);
			const wanted = new Set<number>(authedIndexes);
			// add the next free slot (>=2) so the user can /login a fresh account
			let spare = 2;
			while (wanted.has(spare) && spare <= config.maxAccountsPerProvider) spare++;
			if (spare <= config.maxAccountsPerProvider) wanted.add(spare);
			for (const index of wanted) {
				if (index <= 1) continue; // base provider is native
				const id = slotId(family, index);
				if (registeredSlots.has(id)) continue;
				if (family === "anthropic") registerAnthropicSlot(pi, id);
				else registerCodexSlot(pi, id);
				registeredSlots.add(id);
			}
		}
	}

	function buildFallbacks(): string[] {
		if (!config.autoDiscover) {
			return config.fallbacks.length > 0 ? config.fallbacks : rotation.slice();
		}
		// Manual fallbacks (if any) take priority, then discovered rotation.
		const merged = [...config.fallbacks, ...rotation];
		return [...new Set(merged)];
	}

	function refreshDiscovery(force = false): boolean {
		const mtime = authMtimeMs();
		if (!force && mtime === lastAuthMtime) return false;
		lastAuthMtime = mtime;
		const auth = readAuthFile();
		clearReauthedInvalidations(auth);
		syncRegisteredSlots(auth);
		rotation = discoverRotation(auth);
		config = { ...config, fallbacks: buildFallbacks() };
		return true;
	}

	function activeFallbacks(): string[] {
		return config.fallbacks.filter((t) => parseTarget(t));
	}

	function configuredProviders(): string[] {
		return [...new Set(activeFallbacks().map((t) => parseTarget(t)?.provider).filter((p): p is string => !!p))];
	}

	function isExhausted(provider: string) {
		pruneCooldowns();
		return (exhaustedUntilByProvider.get(provider) ?? 0) > Date.now();
	}

	// ----- fallback selection ----------------------------------------------

	function resolveTarget(ctx: any, target: string, currentModel: any) {
		const parsed = parseTarget(target);
		if (!parsed) return undefined;
		if (parsed.modelId) return ctx.modelRegistry.find(parsed.provider, parsed.modelId);

		const sameModel = currentModel?.id ? ctx.modelRegistry.find(parsed.provider, currentModel.id) : undefined;
		if (sameModel) return sameModel;

		const family = classifyProvider(parsed.provider, config.qwenProvider);
		const preferred = family === "anthropic" ? DEFAULT_ANTHROPIC_MODELS : family === "openai-codex" ? DEFAULT_CODEX_MODELS : [];
		for (const modelId of preferred) {
			const model = ctx.modelRegistry.find(parsed.provider, modelId);
			if (model) return model;
		}
		return ctx.modelRegistry.getAll().find((model: any) => model.provider === parsed.provider);
	}

	function targetMatchesCurrent(target: string, currentModel: any) {
		const parsed = parseTarget(target);
		if (!parsed || !currentModel) return false;
		if (parsed.provider !== currentModel.provider) return false;
		return !parsed.modelId || parsed.modelId === currentModel.id;
	}

	/**
	 * Returns fallback models ordered by **time-to-recovery** (soonest first).
	 *
	 * Selection policy (never random, never just "next in list"):
	 *   1. Accounts available right now (no active cooldown) win, in deterministic
	 *      rotation order as a tiebreak.
	 *   2. If every account is on cooldown, probe the one with the SHORTEST remaining
	 *      cooldown first — i.e. the account that will recover soonest — honoring the
	 *      per-provider probe interval so we don't hammer a still-limited account.
	 */
	function findFallbackModels(ctx: any, currentModel: any, options: { availableNowOnly?: boolean } = {}) {
		const fallbacks = activeFallbacks();
		if (fallbacks.length === 0) return [];

		const now = Date.now();
		const lastProbe = lastProbeMap();

		type Scored = { model: any; remaining: number; rotIndex: number; probeReady: boolean };
		const scored: Scored[] = [];
		const seen = new Set<string>();

		for (let i = 0; i < fallbacks.length; i++) {
			const model = resolveTarget(ctx, fallbacks[i], currentModel);
			if (!model) continue;
			if (model.provider === currentModel?.provider && model.id === currentModel?.id) continue;
			if (isInvalidated(model.provider)) continue; // dead auth — never select
			const key = `${model.provider}/${model.id}`;
			if (seen.has(key)) continue;
			seen.add(key);

			const exhaustedUntil = exhaustedUntilByProvider.get(model.provider) ?? 0;
			const remaining = Math.max(0, exhaustedUntil - now);
			const probeReady = now - (lastProbe[model.provider] ?? 0) >= config.probeCooldownMs;
			scored.push({ model, remaining, rotIndex: i, probeReady });
		}
		if (scored.length === 0) return [];

		// (1) Anything available right now → soonest-recovered wins (all remaining=0),
		// deterministic rotation-order tiebreak.
		let availableNow = scored.filter((s) => s.remaining === 0).sort((a, b) => a.rotIndex - b.rotIndex);
		// Anti-ping-pong: don't bounce straight back to the account we just left if any
		// other account is also free right now — that's the loop that freezes the machine.
		if (lastLeftProvider && now - lastLeftAt < ANTI_PINGPONG_MS && availableNow.length > 1) {
			availableNow = availableNow.filter((s) => s.model.provider !== lastLeftProvider);
		}
		if (availableNow.length > 0) return availableNow.map((s) => s.model);

		// Immediate failover must NEVER switch into a still-exhausted account: that account
		// would re-fail at once and the rotation would ping-pong forever. When nothing is
		// available right now, the caller falls back to the delayed pending-resume path.
		if (options.availableNowOnly) return [];

		// (2) All exhausted → closest-to-recovery first (shortest remaining cooldown).
		// Only reached by the pending-resume probe, which is rate-limited per provider.
		const probeable = scored.filter((s) => s.probeReady);
		const pool = probeable.length > 0 ? probeable : scored;
		return pool.sort((a, b) => a.remaining - b.remaining || a.rotIndex - b.rotIndex).map((s) => s.model);
	}

	async function switchToFallback(ctx: any, reason: string, cooldownMs = config.cooldownMs) {
		if (!config.enabled) return false;
		const currentModel = ctx.model;
		if (!currentModel) return false;

		markExhausted(currentModel.provider, cooldownMs);
		lastLeftProvider = currentModel.provider;
		lastLeftAt = Date.now();
		// Immediate failover only ever switches to an account that is usable RIGHT NOW. If
		// none is, we don't bounce into an exhausted one — we arm the delayed pending-resume
		// path, which probes accounts as their cooldowns expire.
		const candidates = findFallbackModels(ctx, currentModel, { availableNowOnly: true });
		if (candidates.length === 0) {
			const cooldowns = [...exhaustedUntilByProvider.entries()]
				.filter(([, until]) => until > Date.now())
				.map(([c, until]) => `${c}: ${formatUntil(until)}`)
				.join(", ");
			ctx.ui.notify(
				`Provider failover: no immediately available fallback after ${currentModel.provider}/${currentModel.id}. ${cooldowns ? `Cooldowns: ${cooldowns}` : "All known accounts may be unauthenticated, invalidated, or same account."}`,
				"warning",
			);
			setPendingContinuation(ctx, reason); // wait for an account to recover, then resume
			return false;
		}

		const from = ref(currentModel.provider, currentModel.id);
		for (const fallback of candidates) {
			const to = ref(fallback.provider, fallback.id);
			const ok = await pi.setModel(fallback);
			if (!ok) {
				// setModel failed → the account has no usable auth right now.
				ctx.ui.notify(`Provider failover: ${to} has no usable auth, dropping from rotation`, "warning");
				markInvalid(fallback.provider, "setModel failed (no usable auth)");
				continue;
			}
			restoreDesiredThinking(); // keep the user's thinking level across the switch
			setLastProbe(fallback.provider);
			currentPromptSwitch = { from, to, reason, at: Date.now() };
			pi.appendEntry("provider-failover", currentPromptSwitch);
			persist({ lastSwitches: [currentPromptSwitch, ...(persistedState.lastSwitches ?? [])].slice(0, 20) });
			ctx.ui.notify(`Provider failover: ${from} → ${to} (${reason})`, "warning");
			return true;
		}
		ctx.ui.notify(`Provider failover: all fallback candidates after ${from} are missing auth or on cooldown`, "warning");
		return false;
	}

	// ----- pending auto-resume ---------------------------------------------

	function continuationPrompt(record: SwitchRecord) {
		return config.continuationPrompt.replaceAll("{from}", record.from).replaceAll("{to}", record.to).replaceAll("{reason}", record.reason);
	}

	/** Mark that the next agent run is our own failover continuation, then send it. */
	function dispatchSelfContinuation(ctx: any, prompt: string) {
		lastAutoContinueAt = Date.now();
		lastSentContinuationPrompt = prompt;
		expectingSelfContinuation = true;
		pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
	}

	/**
	 * Send an auto-continuation, but never faster than MIN_AUTOCONTINUE_INTERVAL_MS.
	 * The spacing keeps a fully rate-limited rotation from pegging CPU/network and gives
	 * the user a real window in which Esc actually sticks.
	 */
	function scheduleAutoContinue(ctx: any, prompt: string) {
		if (autoContinueTimer) {
			clearTimeout(autoContinueTimer);
			autoContinueTimer = undefined;
		}
		const wait = Math.max(0, MIN_AUTOCONTINUE_INTERVAL_MS - (Date.now() - lastAutoContinueAt));
		if (wait === 0) {
			dispatchSelfContinuation(ctx, prompt);
			return;
		}
		autoContinueTimer = setTimeout(() => {
			autoContinueTimer = undefined;
			if (userAbortedChain || ctx.signal?.aborted) return; // user took over while we waited
			dispatchSelfContinuation(ctx, prompt);
		}, wait);
		ctx.ui.notify(`Provider failover: next auto-continue in ~${Math.ceil(wait / 1000)}s (press Esc to cancel).`, "info");
	}

	function clearPendingContinuation() {
		if (pendingWakeTimer) {
			clearTimeout(pendingWakeTimer);
			pendingWakeTimer = undefined;
		}
		persistedState = { ...persistedState, pendingContinuationPrompt: undefined, pendingSince: undefined, pendingReason: undefined };
		persist();
	}

	function nextPendingWakeDelayMs() {
		if (!persistedState.pendingContinuationPrompt) return undefined;
		const now = Date.now();
		const lastProbe = lastProbeMap();
		let bestWakeAt = Number.POSITIVE_INFINITY;
		for (const provider of configuredProviders()) {
			if (isInvalidated(provider)) continue;
			const exhaustedUntil = exhaustedUntilByProvider.get(provider) ?? 0;
			if (exhaustedUntil <= now) return 1000;
			const probeDueAt = (lastProbe[provider] ?? 0) + config.probeCooldownMs;
			bestWakeAt = Math.min(bestWakeAt, exhaustedUntil, probeDueAt);
		}
		if (!Number.isFinite(bestWakeAt)) return config.probeCooldownMs;
		return Math.max(1000, Math.min(bestWakeAt - now, 2_147_483_647));
	}

	function schedulePendingWake(ctx?: any) {
		if (ctx) latestCtx = ctx;
		if (pendingWakeTimer) clearTimeout(pendingWakeTimer);
		const delayMs = nextPendingWakeDelayMs();
		if (delayMs === undefined) return;
		pendingWakeTimer = setTimeout(() => {
			pendingWakeTimer = undefined;
			void attemptPendingResume();
		}, delayMs);
	}

	function setPendingContinuation(ctx: any, reason: string) {
		// Don't re-arm or re-notify if a pending resume is already queued — switchToFallback
		// and agent_end can both reach here for the same exhaustion, and the wake timer is
		// already running.
		const alreadyPending = !!persistedState.pendingContinuationPrompt;
		const current = ctx.model ? ref(ctx.model.provider, ctx.model.id) : ("unknown/model" as ModelRef);
		const record: SwitchRecord = { from: current, to: "next-available/account" as ModelRef, reason, at: Date.now() };
		persistedState = {
			...persistedState,
			pendingContinuationPrompt: persistedState.pendingContinuationPrompt || continuationPrompt(record),
			pendingSince: persistedState.pendingSince || Date.now(),
			pendingReason: reason,
		};
		persist();
		schedulePendingWake(ctx);
		if (alreadyPending) return;
		const delayMs = nextPendingWakeDelayMs();
		ctx.ui.notify(
			`Provider failover: all accounts appear exhausted. Will automatically probe/resume in ~${Math.ceil((delayMs ?? config.probeCooldownMs) / 1000)}s if this Pi session stays open.`,
			"warning",
		);
	}

	async function attemptPendingResume() {
		const ctx = latestCtx;
		const prompt = persistedState.pendingContinuationPrompt;
		if (!ctx || !prompt || !config.enabled || !config.autoContinue) return;
		if (userAbortedChain) {
			clearPendingContinuation(); // user took over — abandon the background resurrection
			return;
		}
		if (autoContinuesThisPrompt >= config.maxAutoContinuesPerPrompt) {
			clearPendingContinuation(); // task-level cap reached — stop resurrecting
			return;
		}
		refreshDiscovery();
		pruneCooldowns();
		const candidates = findFallbackModels(ctx, ctx.model);
		if (candidates.length === 0) {
			schedulePendingWake(ctx);
			return;
		}
		for (const candidate of candidates) {
			const to = ref(candidate.provider, candidate.id);
			const ok = await pi.setModel(candidate);
			if (!ok) {
				markInvalid(candidate.provider, "setModel failed on resume");
				continue;
			}
			restoreDesiredThinking(); // keep the user's thinking level across the switch
			setLastProbe(candidate.provider);
			clearPendingContinuation();
			// A genuine recovery after a real wait earns a fresh continuation budget so the
			// agent can keep going whenever an account recovers; rapid flapping (resume that
			// immediately re-limits) does NOT reset, so the cap still bounds a tight loop.
			if (Date.now() - lastAutoContinueAt >= config.probeCooldownMs) autoContinuesThisPrompt = 0;
			ctx.ui.notify(`Provider failover: resuming pending work on ${to}`, "warning");
			dispatchSelfContinuation(ctx, prompt);
			return;
		}
		schedulePendingWake(ctx);
	}

	// ----- error classification --------------------------------------------

	function isAuthError(text: string) {
		if (!text.trim()) return false;
		if (patternMatch(text, config.ignoreErrorPatterns)) return false;
		return patternMatch(text, config.authErrorPatterns);
	}

	function isLimitError(text: string) {
		if (!text.trim()) return false;
		if (patternMatch(text, config.ignoreErrorPatterns)) return false;
		return patternMatch(text, config.limitErrorPatterns);
	}

	// ----- command ----------------------------------------------------------

	async function handleCommand(args: string, ctx: any) {
		latestCtx = ctx;
		const [commandRaw, arg1] = args.trim().split(/\s+/);
		const command = (commandRaw || "status").toLowerCase();

		if (command === "reload") {
			config = loadConfig();
			refreshDiscovery(true);
			ctx.ui.notify("pi-multi-account: config reloaded and accounts re-discovered", "info");
			return;
		}
		if (command === "rediscover") {
			const changed = refreshDiscovery(true);
			ctx.ui.notify(`pi-multi-account: rediscovered accounts${changed ? "" : " (no auth.json change)"}. Rotation: ${rotation.join(" → ") || "none"}`, "info");
			return;
		}
		if (command === "add") {
			const family = arg1 === "codex" || arg1 === "openai" ? "openai-codex" : "anthropic";
			const auth = readAuthFile();
			let n = 2;
			while (auth[slotId(family, n)] && n <= config.maxAccountsPerProvider) n++;
			const id = slotId(family, n);
			syncRegisteredSlots(auth);
			ctx.ui.notify(`pi-multi-account: run  /login ${id}  to add a new ${family} account, then  /multi-account rediscover`, "info");
			return;
		}
		if (command === "reset") {
			exhaustedUntilByProvider.clear();
			currentPromptSwitch = undefined;
			autoContinuesThisPrompt = 0;
			if (pendingWakeTimer) {
				clearTimeout(pendingWakeTimer);
				pendingWakeTimer = undefined;
			}
			persistedState = { stateVersion: STATE_VERSION, exhaustedUntilByProvider: {}, lastProbeAtByProvider: {}, invalidatedByProvider: {}, lastSwitches: [] };
			invalidatedByProvider.clear();
			saveState(persistedState);
			refreshDiscovery(true);
			ctx.ui.notify("pi-multi-account: cooldowns, invalidations and pending resume reset", "info");
			return;
		}
		if (command === "next") {
			await switchToFallback(ctx, "manual /multi-account next", 5 * 60 * 1000);
			return;
		}
		if (command === "enable" || command === "disable") {
			config = { ...config, enabled: command === "enable" };
			ctx.ui.notify(`pi-multi-account: failover ${config.enabled ? "enabled" : "disabled"} for this Pi process`, "info");
			return;
		}

		refreshDiscovery();
		const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
		const cooldowns = [...exhaustedUntilByProvider.entries()]
			.filter(([p, until]) => until > Date.now() && !isInvalidated(p))
			.map(([p, until]) => `${p}: ${formatUntil(until)}`);
		const invalids = [...invalidatedByProvider.entries()].map(([p, r]) => `${p} (${r.reason.slice(0, 40)})`);
		ctx.ui.notify(
			[
				`pi-multi-account: ${config.enabled ? "enabled" : "disabled"}${config.autoDiscover ? " · auto-discover ON" : " · auto-discover OFF"}`,
				`Current: ${current}`,
				`Rotation (${rotation.length}): ${rotation.join(" → ") || "none — log in to an account"}`,
				`Registered login slots: ${[...registeredSlots].join(", ") || "(base accounts only)"}`,
				`Cooldowns: ${cooldowns.length ? cooldowns.join(", ") : "none"}`,
				`Invalidated (need re-login): ${invalids.length ? invalids.join(", ") : "none"}`,
				`Pending auto-resume: ${persistedState.pendingContinuationPrompt ? `yes (reason: ${persistedState.pendingReason ?? "unknown"})` : "none"}`,
				`Config: ${CONFIG_PATH}`,
				`Commands: status | rediscover | add [anthropic|codex] | next | reset | reload | enable | disable`,
			].join("\n"),
			"info",
		);
	}

	for (const name of ["multi-account", "provider-failover", "failover"]) {
		pi.registerCommand(name, { description: "Manage automatic multi-account failover & rotation", handler: handleCommand });
	}

	// ----- Anthropic OAuth out of the box -----------------------------------
	// Enable Claude Pro/Max OAuth login on the base `anthropic` provider and shape
	// every Anthropic OAuth request so subscription tokens are accepted — without
	// requiring a separate pi-anthropic-auth install. Idempotent, so it coexists
	// safely if pi-anthropic-auth is also present.
	pi.registerProvider("anthropic", { oauth: anthropicOAuthOverride } as any);
	pi.on("before_provider_request", (event: any) => shapeAnthropicOAuthPayload(event.payload));

	// ----- lifecycle hooks --------------------------------------------------

	refreshDiscovery(true);

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		refreshDiscovery(true);
		pruneCooldowns();
		// Tight session binding: every session starts as a clean slate. Auto-resume only ever
		// runs *inside the live session that hit the limit* (its timer is armed by
		// setPendingContinuation). A new session — or a reopened one after a crash — must NEVER
		// inherit and silently restart a previous session's paused work, so we drop any leftover
		// pending state and reset all in-memory guards here.
		if (persistedState.pendingContinuationPrompt) clearPendingContinuation();
		autoContinuesThisPrompt = 0;
		userAbortedChain = false;
		expectingSelfContinuation = false;
		lastSentContinuationPrompt = "";
		ctx.ui.notify(
			`pi-multi-account loaded (${config.enabled ? "enabled" : "disabled"}). ${rotation.length} account(s) in rotation. Config: ${CONFIG_PATH}`,
			"info",
		);
	});

	// CRITICAL: when the current session ends — for ANY reason (quit, reload, or replacement
	// by a new/resumed/forked session) — the extension's background activity must end with it.
	// Kill every timer and drop the pending continuation so nothing survives the session.
	pi.on("session_shutdown", async () => {
		if (pendingWakeTimer) {
			clearTimeout(pendingWakeTimer);
			pendingWakeTimer = undefined;
		}
		if (autoContinueTimer) {
			clearTimeout(autoContinueTimer);
			autoContinueTimer = undefined;
		}
		clearPendingContinuation();
		userAbortedChain = false;
		expectingSelfContinuation = false;
		autoContinuesThisPrompt = 0;
		lastSentContinuationPrompt = "";
	});

	// Distinguish a genuine new user prompt from our own failover continuation. Only a
	// genuine prompt resets the per-task auto-continue counter and cancels any pending
	// resurrection — this is what stops maxAutoContinuesPerPrompt from resetting every
	// iteration (the bug that let the failover loop run forever).
	pi.on("before_agent_start", async (event) => {
		const prompt = typeof (event as any).prompt === "string" ? (event as any).prompt : "";
		const isSelfContinuation =
			expectingSelfContinuation || (!!lastSentContinuationPrompt && prompt.trim() === lastSentContinuationPrompt.trim());
		if (isSelfContinuation) return;
		// Genuine user input → fresh task: reset the chain and stop any auto-resume so the
		// user is fully back in control.
		autoContinuesThisPrompt = 0;
		userAbortedChain = false;
		lastSentContinuationPrompt = "";
		if (autoContinueTimer) {
			clearTimeout(autoContinueTimer);
			autoContinueTimer = undefined;
		}
		if (persistedState.pendingContinuationPrompt) clearPendingContinuation();
	});

	pi.on("agent_start", async () => {
		currentPromptSwitch = undefined;
		expectingSelfContinuation = false; // consume the flag once the run has started
		lastErrorText = "";
		captureDesiredThinking(); // remember the level BEFORE any failover can clamp it
		refreshDiscovery(); // cheap: only re-scans when auth.json changed (new /login)
	});

	pi.on("after_provider_response", async (event, ctx) => {
		latestCtx = ctx;
		if (!config.enabled) return;
		if (userAbortedChain || ctx.signal?.aborted) return; // user is cancelling — don't fail over
		const status = (event as any).status;
		if (status === 401) {
			// Authorization is dead → drop this account, then move on.
			if (ctx.model) markInvalid(ctx.model.provider, `HTTP 401`);
			await switchToFallback(ctx, "HTTP 401 (auth invalid)");
			return;
		}
		if (status !== 429 && status !== 402 && status !== 403) return;
		const cooldownMs = cooldownFromHeaders((event as any).headers ?? {}) ?? config.cooldownMs;
		await switchToFallback(ctx, `HTTP ${status}`, cooldownMs);
	});

	pi.on("message_end", async (event, ctx) => {
		latestCtx = ctx;
		const message = (event as any).message;
		if (message?.role !== "assistant" || message.stopReason !== "error") return;
		if (userAbortedChain || ctx.signal?.aborted) return; // user is cancelling — don't fail over
		const errorText = typeof message.errorMessage === "string" ? message.errorMessage : "";
		lastErrorText = errorText;
		if (currentPromptSwitch) return;
		if (isAuthError(errorText)) {
			if (ctx.model) markInvalid(ctx.model.provider, errorText.slice(0, 60));
			await switchToFallback(ctx, `auth invalid: ${errorText.slice(0, 100)}`);
			return;
		}
		if (isLimitError(errorText)) {
			await switchToFallback(ctx, `assistant error: ${errorText.slice(0, 120)}`, cooldownFromErrorText(errorText) ?? config.cooldownMs);
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		latestCtx = ctx;
		if (!config.enabled || !config.autoContinue) return;

		// Respect the user: if they pressed Esc, the last assistant message is "aborted".
		// Stop the failover chain dead and cancel every background timer so nothing
		// resurrects the task. It only restarts when the user sends a new prompt.
		if (lastAssistantStopReason((event as any).messages ?? []) === "aborted" || ctx.signal?.aborted) {
			userAbortedChain = true;
			if (autoContinueTimer) {
				clearTimeout(autoContinueTimer);
				autoContinueTimer = undefined;
			}
			clearPendingContinuation();
			currentPromptSwitch = undefined;
			lastErrorText = "";
			return;
		}
		if (userAbortedChain) return;

		const errorText = lastErrorText || getAssistantErrorText((event as any).messages ?? []);
		if (isAuthError(errorText) && ctx.model) markInvalid(ctx.model.provider, errorText.slice(0, 60));
		if (!isLimitError(errorText) && !isAuthError(errorText)) return;

		// Task-level cap. Because this counter is no longer reset by our own re-prompts,
		// it genuinely bounds the failover loop. When it trips we stop completely (and do
		// NOT arm a resurrection timer) so the machine can't be driven into a swap spiral.
		if (autoContinuesThisPrompt >= config.maxAutoContinuesPerPrompt) {
			ctx.ui.notify(
				`Provider failover: stopped after ${autoContinuesThisPrompt} auto-continues — every account kept hitting limits. Send a new message, or run /multi-account reset to retry.`,
				"warning",
			);
			return;
		}

		if (!currentPromptSwitch) {
			const reason = `agent ended with provider limit: ${errorText.slice(0, 120)}`;
			const switched = await switchToFallback(ctx, reason, cooldownFromErrorText(errorText) ?? config.cooldownMs);
			// switchToFallback already arms pending-resume when nothing is available now, so
			// only set it here if it somehow didn't (defensive; alreadyPending makes it a no-op).
			if (!switched && !currentPromptSwitch && !persistedState.pendingContinuationPrompt) {
				setPendingContinuation(ctx, reason);
				return;
			}
		}

		if (currentPromptSwitch) {
			autoContinuesThisPrompt++;
			const prompt = continuationPrompt(currentPromptSwitch);
			scheduleAutoContinue(ctx, prompt); // spaced + Esc-cancellable, not a tight loop
		}
	});
}
