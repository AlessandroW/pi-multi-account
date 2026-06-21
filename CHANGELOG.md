# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.9.1] - 2026-06-21

### Fixed

- **Ollama/Alibaba not picked up by Pi.** The extension expected Pi to register
  the base `ollama`/`alibaba` providers natively from `models.json`, but if the
  `apiKey` field there was a placeholder (e.g. `"ollama"`), Pi never exposed the
  provider to `modelRegistry` — so `resolveTargets()` returned `[]` and the
  family never failovered. The extension now registers the base API-key
  provider itself (with the real key from `auth.json`) via
  `ensureApiKeyBaseProvider()`, making Ollama and Alibaba/Qwen first-class
  rotation members.
- **`pi.registerProvider` error for spare API-key slots.** API-key families
  (ollama, qwen) no longer auto-register a spare slot — there is no
  interactive `/login` for them, so an empty spare triggered Pi's
  `"apiKey or oauth is required when defining models"` error.
- **Test flake: api_key transient cooldown assertion.** Relaxed the sub-minute
  bound to sub-2min to accommodate `markExhausted`'s 1-second floor.

## [1.9.0] - 2026-06-21

### Fixed

- **False permanent invalidation of live OAuth accounts.** A single transient
  401 burst from OpenAI Codex (one physical event surfaced as three error hooks)
  hit `MAX_CONSECUTIVE_AUTH_FAILURES = 3` instantly and permanently killed a
  live account for a year, even while a parallel Pi session was successfully
  using the same token. The threshold is raised to 8 and the dedup logic now
  ignores same-hash repeat failures (refresh didn't reach the wire), so only
  genuinely distinct refreshed-token failures advance the kill counter.
- **`refresh_token_invalidated` / `session has ended` no longer treated as
  terminal.** OpenAI Codex returns these transiently under load. They are now
  classified as transient — the account gets a short cooldown and the next
  attempt can still refresh. Only `invalid_grant` and `revoked` remain terminal.
- **365-day "cooldown" entries removed.** `markInvalid` no longer writes a
  year-long entry into `exhaustedUntilByProvider` — that polluted cooldown
  displays ("Cooldowns: account-2: 8696h") and confused users into thinking
  dead accounts were rate-limited. Invalidated providers are reported
  separately. `switchToFallback` no longer applies `invalidCooldownMs` to a
  killed account (it's already in `invalidatedByProvider`).
- **API-key providers (Ollama, Alibaba) survive a bare 401.** Previously a
  single 401 on an api_key provider immediately invalidated it for a year.
  Now only explicit terminal patterns (`invalid api key`, `incorrect api key`,
  `revoked`) kill the slot; a bare 401 gets a transient cooldown and the same
  consecutive-failure accounting as OAuth.
- **Warning messages separate invalidated from cooldowns.** The "no
  immediately available fallback" warning no longer lists dead accounts with
  8696h timers — they're shown as `Invalidated (need re-login)`.

### Added

- **Multi-account support for Ollama and Alibaba/Qwen.** API-key providers
  now support numbered alias slots (`ollama-account-2`, `alibaba-account-3`,
  …) exactly like OAuth providers. Each slot is a separate API key in
  `auth.json` and joins the rotation automatically. `/multi-account add
  ollama|qwen` registers the next free slot.
- **`/multi-account revive <provider|all>`** — clear a false invalidation
  and return an account to rotation without wiping all state (unlike `reset`).
- **Ollama (GLM-5.2) and Alibaba (Qwen3.7-Max) in the default rotation.**
  `classifyProvider` recognizes `ollama-account-N` and `alibaba-account-N`;
  `resolveTargets` knows the preferred models for each family.

### Changed

- `DEFAULT_QWEN_MODELS = ["qwen3.7-max", "qwen-max", "qwen-plus"]`.
- `slotId` and `syncRegisteredSlots` generalized to all four provider
  families. API-key families skip the "spare slot" auto-registration (no
  interactive login) to avoid Pi's "apiKey or oauth required" error.

## [1.8.0] - 2026-06-20

### Fixed

- **Failover no longer triggers for unmanaged providers.** Previously, a
  rate-limit (429) or quota error on *any* provider — including ones this
  extension does not manage (Ollama, OpenRouter, DeepSeek, etc.) — triggered
  the failover logic and switched the user to an unrelated managed account.
  The `message_end` and `after_provider_response` handlers now check
  `classifyProvider()` before reacting, so only errors from anthropic,
  openai-codex, qwen, or ollama providers activate failover.
- **No more false “all limits exhausted” from setModel failures.** When
  `activateFallback` tried to switch to a fallback account and the
  `pi.setModel()` call failed (for any reason — model not found, SDK error,
  etc.), it called `markExhausted()` on that account. If several candidates
  failed in a row, *all* managed accounts appeared exhausted in the status
  even though none had actually hit a limit. setModel failures now simply skip
  the candidate for the current attempt without persisting a cooldown.

### Added

- **Ollama provider support.** Ollama is now a first-class provider family in
  the rotation, alongside Anthropic, OpenAI Codex, and Qwen. The default
  model is `glm-5.2:cloud`. Enable/disable with the `includeOllama` config
  option (default `true`).

## [1.7.0] - 2026-06-13

### Fixed

- **Cooldowns no longer reset on routine OAuth token refresh.** A rate-limit
  cooldown was keyed to the credential blob, so the periodic access-token refresh
  that Pi performs looked like a re-login and wiped the cooldown — the still-limited
  account was then re-selected and instantly hit the same 429. Cooldowns now clear
  only when the slot is genuinely re-logged into a *different* real account (stable
  account fingerprint changes); a token rotation keeps the recovery time intact.
- **`/multi-account next` now cycles through every account.** It walked to the
  account with the shortest remaining cooldown, which made repeated presses bounce
  between just the two soonest-to-recover accounts and never reach the rest of the
  rotation. It now round-robins forward from the current account (offering any
  account that is free *right now* first), so each press advances through all slots.
- **Paused sessions resume on the first account that *actually* recovers.** While
  every account is cooling down the session now re-checks availability on a short
  poll instead of sleeping on a single multi-hour estimate, and it reconciles each
  cooling account against its live usage endpoint. An account whose real limit reset
  earlier than the recorded estimate (or that a parallel `/login` freed) now picks
  the work back up promptly instead of waiting out a stale countdown.
- Wait-time messages show an honest duration (e.g. `2h 20m`) instead of rounding
  up to a misleading whole hour (`~3h`).

### Added

- `pendingPollMs` config option (default 60s): how often a paused session re-checks
  account availability while waiting for a cooldown to clear.

## [1.6.0] - 2026-06-13

### Added

- Persistent Pi footer status for the active Codex or Anthropic OAuth account,
  showing remaining 5-hour and 7-day allowance with reset countdowns.
- `/multi-account limits [refresh]` (also `usage` and `quota`) for detailed
  active-account percentages, reset timestamps, plan, and Codex credits.
- Provider usage caching keyed by credential fingerprint. Codex response
  headers refresh the cache without another request; direct usage calls are
  deduplicated and Anthropic polling is limited to at most once per 10 minutes.

## [1.5.0] - 2026-06-11

### Fixed

- Failover decisions now happen only on the final assistant error. Intermediate
  provider HTTP retries can contribute reset metadata but can no longer switch
  the active model or falsely blame the next account.
- A physical 401 is counted once instead of once in each response, message, and
  agent hook. Version-3 one-year invalidations created by that bug are removed
  during state migration.
- Continuations queued from `agent_end` now use Pi's required `followUp`
  delivery mode while the agent is still active.
- Manual model selection no longer permanently disables failover when that
  selected model later returns a real final limit.
- Explicit fallback lists and auto-discovery now share real-account
  deduplication. Codex slots use the stable `accountId` stored by Pi.
- New logins that provably duplicate an existing real account are rejected, and
  already-present duplicate slots are reported and omitted from rotation.
- A fallback whose `setModel()` has no usable authorization is invalidated and
  skipped without preventing the next candidate from being tried.
- Anthropic OAuth request shaping now identifies as the locally installed
  Claude Code `2.1.172` instead of the stale `2.1.150` billing-header version.
- Explicit provider verdicts such as `authentication token has been
  invalidated` now force-refresh the access token even before its local expiry.
  A permanently invalid refresh token removes the account and prints the
  interactive `/login` recovery steps.
- Slash commands and shell shortcuts bypass the all-accounts-cooling input
  queue, so `/login` and other recovery commands remain usable.
- Consecutive account failures in one continuation chain are handled
  independently; a previous switch no longer hides the next account's error.
- Manual `/multi-account next` can deliberately probe the next account even
  when every fallback has a recorded cooldown, without arming an automatic
  continuation.

### Added

- Session-bound delayed resume: when every account is cooling down, an open Pi
  session retries at the earliest known recovery and continues the task.
- `/multi-account stop` to abort and cancel the current failover/resume chain.
- State-machine tests covering retry ordering, final-error deduplication,
  authoritative message providers, duplicate accounts, failed model selection,
  continuation caps, cancellation, migration, and delayed resume.

## [1.4.0] - 2026-06-10

### Fixed

- **A single 401 no longer drops an account that still has valid tokens.** A 401 on
  an OAuth account usually just means the access token needs a refresh (Pi refreshes
  on the next call). Previously the first 401 permanently invalidated the account
  (≈1-year cooldown until re-login) and yanked you onto another — often broken —
  account. Now a refreshable account is given a brief cooldown and retried; it is
  only marked dead after 3 consecutive 401s with no success in between. A
  non-refreshable (API-key) 401 is still treated as immediately fatal.
- Any successful response clears that account's 401 streak.

### Added

- Tests for transient-401 tolerance, the consecutive-401 kill threshold, and
  success-resets-streak (suite now 17 tests).

## [1.3.0] - 2026-06-10

### Fixed

- **Manual model/account selection is now respected.** Picking a model (e.g. Opus
  on another account) no longer gets auto-yanked onto a different provider on the
  next rate limit — the failover stays put and tells you, until you switch with
  `/model` or `/multi-account next`. The pin auto-releases after a successful
  response on that provider.
- **No more self-resurrecting work.** All background resume timers were removed:
  continuation now happens only synchronously inside an active turn, so Esc and
  quitting always stop it. When every account is rate-limited the failover STOPS
  and asks you to retry, instead of churning between exhausted accounts.
- **No more "Agent is already processing" / "Cannot continue from message role:
  assistant".** Continuations are sent only when the agent is idle and not aborting.

### Added

- Test suite (`npm test`) covering the failover edge cases: limit/401 failover,
  all-accounts-exhausted stop, Esc/abort, manual-selection pinning, idle gating,
  Anthropic OAuth shaping idempotency, and session shutdown. Wired into CI.

## [1.2.0] - 2026-06-10

### Added

- **Anthropic (Claude Pro/Max) OAuth now works out of the box.** OAuth login is
  enabled on the base `anthropic` provider and on every `anthropic-account-*`
  alias, and outgoing Anthropic OAuth requests are shaped (billing header +
  system-prompt normalization) directly by this package. A separate
  `pi-anthropic-auth` install is no longer required.

### Changed

- Request shaping is idempotent and only touches OAuth-marked Anthropic requests,
  so it coexists safely with `pi-anthropic-auth` if both are installed, and leaves
  API-key Anthropic and OpenAI Codex / Qwen requests untouched.

### Credits

- Anthropic OAuth request-shaping logic vendored from
  [`gotgenes/pi-anthropic-auth`](https://github.com/gotgenes/pi-anthropic-auth) (MIT).

## [1.1.0] - 2026-06-10

### Fixed

- **Runaway failover loop that could freeze the machine.** When every account was
  rate-limited the rotation ping-ponged between accounts every 1–9s indefinitely,
  growing session history until the system swapped itself to death. The
  auto-continue counter was reset on every agent start, so `maxAutoContinuesPerPrompt`
  never actually bounded the loop. The counter is now reset only by a genuine new
  user prompt, making the cap a real per-task limit.
- **Escape did not stop the loop.** Auto-continuation ran from background event
  hooks and a timer, so cancelling the agent was immediately undone. User aborts
  (`stopReason: "aborted"` / `ctx.signal`) now stop the chain and cancel all timers.

### Added

- Anti-ping-pong guard: immediate failover only switches to an account usable right
  now and never bounces straight back to the account it just left within 60s.
- Minimum 15s spacing between auto-continuations (no tight CPU/network loop, and a
  real window for Esc to take effect).
- In-session auto-resume: when the whole fallback circle is exhausted, the extension
  waits and continues the agent's work as soon as any account recovers — for as long
  as the session stays open.

### Changed

- **Tight session binding.** Background activity is now scoped to the live session:
  ending or replacing a session (quit, reload, new, resume, fork) cancels all timers
  and drops any pending resume. A new session starts clean and never inherits a
  previous session's paused work; nothing survives once Pi exits.

## [1.0.0] - 2026-06-09

### Added

- Initial public release.
- Automatic multi-account failover & rotation across Anthropic (Claude),
  OpenAI / ChatGPT Codex, and Qwen / Alibaba.
- Auto-discovery of authenticated accounts from `~/.pi/agent/auth.json`; the
  rotation grows on login and drops accounts on logout, token expiry, or
  authorization errors.
- Quota / rate-limit failover with provider-reset-aware cooldowns and circular
  fallback ordering.
- Optional auto-continue of the interrupted task after a switch.
- Thinking-level preservation across model switches.
- Commands `/multi-account`, `/provider-failover`, `/failover` with
  `status | rediscover | add | next | reset | reload | enable | disable`.
- Plaintext-free credential handling (SHA-256 fingerprints only); `0600`
  config/state files.

[1.6.0]: https://github.com/Sarrius/pi-multi-account/releases/tag/v1.6.0
[1.5.0]: https://github.com/Sarrius/pi-multi-account/releases/tag/v1.5.0
[1.4.0]: https://github.com/Sarrius/pi-multi-account/releases/tag/v1.4.0
[1.3.0]: https://github.com/Sarrius/pi-multi-account/releases/tag/v1.3.0
[1.2.0]: https://github.com/Sarrius/pi-multi-account/releases/tag/v1.2.0
[1.1.0]: https://github.com/Sarrius/pi-multi-account/releases/tag/v1.1.0
[1.0.0]: https://github.com/Sarrius/pi-multi-account/releases/tag/v1.0.0
