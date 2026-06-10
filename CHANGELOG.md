# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.2.0]: https://github.com/Sarrius/pi-multi-account/releases/tag/v1.2.0
[1.1.0]: https://github.com/Sarrius/pi-multi-account/releases/tag/v1.1.0
[1.0.0]: https://github.com/Sarrius/pi-multi-account/releases/tag/v1.0.0
