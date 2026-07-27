import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_DIR =
	process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const CURSOR_PROVIDER_ROOT =
	process.env.PI_CURSOR_PROVIDER_ROOT ||
	join(AGENT_DIR, "git/github.com/ndraiman/pi-cursor-provider");

export const CURSOR_BASE = "cursor";

export function isCursorProviderId(id: string): boolean {
	return id === CURSOR_BASE || /^cursor-account-\d+$/.test(id);
}

/**
 * Whether the (separately cloned) Cursor provider is present on disk.
 *
 * `includeCursor` defaults to true, but the provider itself is an optional external
 * repo. Without this check the extension registered a `cursor-account-2` login slot
 * backed by nothing and warned about a `git clone` at every start — noise for the
 * majority of users who never asked for Cursor. Cheap enough (one existsSync) to call
 * on every discovery pass, and it picks up a later clone without a restart.
 */
export function isCursorProviderInstalled(): boolean {
	return existsSync(join(CURSOR_PROVIDER_ROOT, "cursor-shared.ts"));
}

type CursorShared = {
	ensureCursorProxy: (
		resolve: (providerId: string) => Promise<string>,
	) => Promise<number>;
	registerCursorProvider: (...args: any[]) => void;
	FALLBACK_MODELS: unknown[];
};
type CursorIndex = { registerSessionLifecycleCleanup?: (pi: ExtensionAPI) => void };

let sharedMod: CursorShared | undefined;
let indexMod: CursorIndex | undefined;
let proxyPort: number | undefined;

async function loadCursorModules(): Promise<CursorShared | undefined> {
	if (sharedMod) return sharedMod;
	const entry = join(CURSOR_PROVIDER_ROOT, "cursor-shared.ts");
	if (!existsSync(entry)) return undefined;
	sharedMod = (await import(
		/* @vite-ignore */ join(CURSOR_PROVIDER_ROOT, "cursor-shared.ts")
	)) as CursorShared;
	const indexEntry = join(CURSOR_PROVIDER_ROOT, "index.ts");
	if (existsSync(indexEntry)) {
		indexMod = (await import(
			/* @vite-ignore */ indexEntry
		)) as CursorIndex;
	}
	return sharedMod;
}

type AuthEntry = {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	key?: string;
	accountId?: string;
};

export async function setupCursorSubscription(
	pi: ExtensionAPI,
	options: {
		readAuth: () => Record<string, AuthEntry>;
		rejectDuplicateLogin?: (slot: string, creds: AuthEntry) => AuthEntry;
		slotIds: string[];
		notify?: (message: string, level: "info" | "warning") => void;
	},
): Promise<number | undefined> {
	const mod = await loadCursorModules();
	if (!mod) {
		options.notify?.(
			`pi-multi-account: Cursor subscription support not found at ${CURSOR_PROVIDER_ROOT}. Run: git clone https://github.com/ndraiman/pi-cursor-provider ${CURSOR_PROVIDER_ROOT}`,
			"warning",
		);
		return undefined;
	}
	if (indexMod?.registerSessionLifecycleCleanup) {
		indexMod.registerSessionLifecycleCleanup(pi);
	}
	const resolveAccessToken = async (providerId: string) => {
		const entry = options.readAuth()[providerId];
		if (!entry || entry.type !== "oauth") return "";
		return typeof entry.access === "string" ? entry.access : "";
	};
	proxyPort = await mod.ensureCursorProxy(resolveAccessToken);
	const ids = [...new Set([CURSOR_BASE, ...options.slotIds])];
	for (const id of ids) {
		mod.registerCursorProvider(pi, id, proxyPort, mod.FALLBACK_MODELS, {
			rejectDuplicateLogin: options.rejectDuplicateLogin,
			onModelsDiscovered: (models: unknown[]) => {
				mod.registerCursorProvider(pi, id, proxyPort!, models as any[], {
					rejectDuplicateLogin: options.rejectDuplicateLogin,
				});
			},
		});
	}
	return proxyPort;
}

export function getCursorProviderRoot(): string {
	return CURSOR_PROVIDER_ROOT;
}
