# pi-multi-account

Automatic multi-account failover & rotation for [Pi Agent](https://pi.dev/), across **Anthropic (Claude)**, **OpenAI / ChatGPT Codex**, and **Qwen / Alibaba**.

When the account you are using hits a quota or rate limit, `pi-multi-account` transparently switches to the next authenticated account/model and (optionally) resumes the interrupted task — so a long agent run does not die just because one account ran out of budget.

## What it does

- **Auto-discovers** every authenticated account from `~/.pi/agent/auth.json` (Anthropic Claude Pro/Max, OpenAI/ChatGPT Codex, and Qwen/Alibaba) and builds the failover rotation dynamically — no manual config editing.
- **Grows the rotation on login.** Run `/login anthropic-account-3` (or `openai-codex-account-5`) to add an account; the next discovery sweep adds it to the rotation automatically. A spare login slot per family is pre-registered so `/login <id>` works out of the box.
- **Drops accounts automatically** the moment their token is expired, revoked, logged out, or returns an auth error — and restores them automatically once you re-login.
- **Fails over on quota / rate-limit** (429 / 402 / 403 and friends): the exhausted account goes on cooldown (parsed from the provider's own reset metadata when available) and Pi switches to the next available account/model.
- **Optional auto-continue**: queues a safe continuation prompt after a switch so the agent keeps going from the last safe point.
- **Keeps your thinking level** stable across switches instead of letting it drift downward.

## Install

```bash
pi install npm:pi-multi-account
```

Restart Pi or run `/reload` after installation.

> **Anthropic OAuth aliases** (`anthropic-account-2`, …) require [`@gotgenes/pi-anthropic-auth`](https://www.npmjs.com/package/@gotgenes/pi-anthropic-auth) for request shaping. The base `anthropic` provider and all OpenAI Codex / Qwen accounts work without it.

### Recommended setting

Set Pi provider-level retries to zero so the SDK does not keep retrying an exhausted account before failover kicks in. In `~/.pi/agent/settings.json`:

```json
{ "retry": { "provider": { "maxRetries": 0 } } }
```

## Usage

Add accounts by logging into numbered slots, then let discovery pick them up:

```text
/login anthropic-account-2
/login openai-codex-account-2
/multi-account rediscover
```

Check what's in the rotation at any time:

```text
/multi-account status
```

Example status output:

```text
pi-multi-account: enabled · auto-discover ON
Current: anthropic/claude-opus-4-8
Rotation (3): anthropic → openai-codex → openai-codex-account-2
Registered login slots: anthropic-account-2, openai-codex-account-2
Cooldowns: none
Invalidated (need re-login): none
Pending auto-resume: none
```

### Commands

All three names are aliases for the same command: `/multi-account`, `/provider-failover`, `/failover`.

| Subcommand | Description |
|---|---|
| `status` (default) | Show enabled state, current model, rotation, login slots, cooldowns, invalidations, pending resume. |
| `rediscover` | Force a re-scan of `auth.json` and rebuild the rotation now. |
| `add [anthropic\|codex]` | Print the next free login slot id to use with `/login`. |
| `next` | Manually switch to the next available fallback. |
| `reset` | Clear all cooldowns, invalidations and any pending auto-resume. |
| `reload` | Reload config from disk and re-discover accounts. |
| `enable` / `disable` | Turn failover on/off for the current Pi process. |

## How rotation membership works

- **Joins the rotation** when an account has a present, non-expired credential in `auth.json` (after `/login`).
- **Leaves the rotation** when the credential is logged out / removed, its access token is expired with no refresh token, or it returns an authorization error (HTTP 401, `invalid_token`, `revoked`, …) during use. Such accounts are marked *invalidated (need re-login)* and skipped until you log in again.
- **Quota / rate-limit** does not invalidate an account — it puts it on a temporary cooldown and the account returns once the cooldown expires.

Rotation refresh is triggered by changes to `auth.json` (detected on session/turn start) or on demand with `/multi-account rediscover`.

## Configuration

A default config is created at `~/.pi/agent/provider-failover.json` on first run. Useful keys:

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `autoContinue` | `true` | Queue a continuation prompt after a switch. |
| `autoDiscover` | `true` | Auto-discover accounts from `auth.json`. |
| `includeQwen` | `true` | Include Qwen / Alibaba accounts. |
| `providerOrder` | `["anthropic","openai-codex","qwen"]` | Preferred family order in the rotation. |
| `cooldownMs` | 6 h | Default cooldown when no reset metadata is provided. |
| `maxAutoContinuesPerPrompt` | `8` | Cap on auto-resume hops per task. |
| `continuationPrompt` | (built-in) | Template; supports `{from}`, `{to}`, `{reason}`. |

State (cooldowns, invalidations, recent switches) is persisted to `~/.pi/agent/provider-failover-state.json`.

## Privacy & security

`pi-multi-account` **reads** `auth.json` but never writes to it and never stores credentials in plaintext. Account/token values are only ever reduced to a short irreversible SHA-256 fingerprint, used solely to detect re-login and deduplicate the same real account logged into multiple slots. The extension makes no network calls of its own — token exchange happens exclusively through Pi's official OAuth providers. Config and state files are written with `0600` permissions.

## License

[MIT](./LICENSE)
