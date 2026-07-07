# What "working" means — and what locks it

This file is the contract. Each row is a promise the extension makes, written in plain language,
next to the automated test that will FAIL the moment that promise breaks. `pnpm test` (94 tests)
runs them all; CI blocks any change that violates a promise. If you hit a behaviour that feels
broken and it is **not** on this list, that is a missing guarantee — it should become a new row +
test, not a one-off patch.

## The promises

| # | Promise (what you should always see) | Locked by test |
|---|--------------------------------------|----------------|
| 1 | **The most powerful model of a provider is always used.** Failover switches the *account*, never quietly drops you to a weaker model. | `manual next never downgrades to a weaker model of the same account (no mini flap)` · `a 'still busy' auto-retry resumes the SAME model — it never downgrades gpt-5.5 to gpt-5.4 on the same account` |
| 2 | **A downgraded turn is upgraded back to the flagship** as soon as it is available again. | `failover prefers the latest model: a turn stuck on gpt-5.4 is upgraded back to gpt-5.5 on a codex→codex switch` |
| 3 | **`/multi-account next` cycles through EVERY logged-in account** — it never collapses onto one provider. | `manual next cycles through every account instead of ping-ponging between two` · `manual next keeps every account selectable and always at its flagship model` |
| 4 | **`/multi-account switch X` switches to X** even if X was left invalidated by an old, since-fixed problem — it revives and selects it. | `manual switch revives a stuck invalidation and selects the account` |
| 5 | **A maxed account is never hot-retried every second.** When usage can't see a session/rate limit, the real cooldown still sticks and the session waits. | `a session limit the usage window can't see is not hot-retried every second` |
| 6 | **A cooldown that was over-estimated is corrected** the moment real usage shows the window reset — you don't wait 6h for nothing. | `a long over-estimated cooldown is corrected by fresh usage and resumes` |
| 7 | **When every account is cooling, work waits and resumes on whichever recovers FIRST** — not in rotation order, not never. | `resume fires on whichever account recovers first, not rotation order` · `all-limited work resumes in the same live session after cooldown` |
| 8 | **A freshly re-logged / re-keyed account returns to rotation** automatically. | `re-login clears a persisted invalidation when the slot credential changes` · `/multi-account revive restores an invalidated account to rotation` |
| 9 | **A transient blip never permanently kills an account.** Only a truly dead credential is removed, and only after repeated proof. | `repeated 401s on the SAME unrefreshed token never permanently invalidate` · `a temporary forced-refresh failure cools the slot without permanently invalidating it` · `one final 401 is counted once, does not invalidate OAuth, and fails over` |
| 10 | **Auto-resume never dead-ends in a red error.** It works even on host builds without `pi.continueAgent`, and never crashes with "Agent is already processing". | `host build WITHOUT pi.continueAgent still auto-resumes the failover ...` · `an un-continuable resume ... recovers by injecting the continuation prompt — never a red error` |
| 11 | **A spent account is benched even if it never threw an error** (known only from a usage snapshot at 100%), so failover never lands on a dead account. | `a spent account known ONLY from a STALE usage snapshot ... is still benched` |
| 12 | **A far-future / bogus cooldown never evicts a live account for weeks.** | `a persisted far-future cooldown is clamped to the live ceiling on load` |
| 13 | **A stuck/silent resumed turn self-heals** — the watchdog cancels it and re-arms resume, but never interrupts a running build/test. | `a silent resumed turn is AUTO-cancelled and auto-resume armed ...` · `the watchdog never aborts a resumed turn while a tool (build/test) is running` |
| 14 | **Repeated failures open a breaker** and drop to manual mode instead of looping forever. | `after repeated resume failures the breaker opens and auto-continue stops (advisory mode)` |

## How to keep this honest

- **Every bug fix adds a row here and a test.** A fix without a locking test is not done.
- Run `pnpm test` before every release; the version in `index.ts` (`const VERSION`) and
  `package.json` must match and be bumped.
- When a promise here can't be expressed as a fast unit test, write the cheapest test that
  exercises the real code path (see `test/failover.test.ts` — it drives the real event handlers
  against a scripted host, not mocks).
