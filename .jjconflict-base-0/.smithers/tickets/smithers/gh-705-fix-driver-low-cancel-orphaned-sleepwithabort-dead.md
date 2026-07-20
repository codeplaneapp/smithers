# 🐛 fix(driver): [low] cancel orphaned sleepWithAbort deadline on winning completion in nextCompletionDecision

GitHub: https://github.com/smithersai/smithers/issues/705

_via ultracode (Opus multi-agent) review_

**Summary:** `nextCompletionDecision(deadlineMs)` races in-flight tasks against a `sleepWithAbort` deadline but never cancels the sleep when a real task wins, leaking a live timer + an abort-listener per completion.

**Location:** `packages/driver/src/WorkflowDriver.js:558-560` (racer setup), `:211-230` (`sleepWithAbort`), `packages/driver/src/withAbort.js:43-55` / `:32` (abort listener lifecycle), re-entry at `WorkflowDriver.js:639` (`handleWait`).

**Mechanism (confirmed):**
- Line 558 pushes `sleepWithAbort(deadlineMs, this.activeOptions?.signal)` into the `Promise.race` at line 560. `Promise.race` does not cancel losers.
- `sleepWithAbort` clears its `setTimeout` only in a `finally` that runs after `withAbort` resolves; `withAbort` resolves only when the sleep timer fires. The `'abort'` listener added at `withAbort.js:32` is removed via `abort.cleanup()` only in that same post-timer `finally`.
- Therefore a lost race leaves a live `setTimeout(deadlineMs)` **and** an `'abort'` listener on the long-lived `activeOptions.signal` until the timer naturally elapses.
- `handleWait` (line 639) re-calls `nextCompletionDecision(deadlineMs)` for every completion while `inflightTasks.size > 0`, with `deadlineMs = reason.waitMs` for RetryBackoff (630-631) — one fresh orphan per winning completion.

**Failure scenario:** one task in a long RetryBackoff (`waitMs≈300_000`) while several siblings keep completing. Each sibling completion → `handleWait(RetryBackoff)` → `nextCompletionDecision(300_000)` arms a new ~5-min timer and adds a new `'abort'` listener; the winning completion orphans each for the full duration. After >10 overlapping completions Node emits the EventTarget/AbortSignal memory-leak warning, and the pile of pending timers keeps the event loop alive past the point the run is idle.

**Why it matters:** spurious `MaxListenersExceededWarning`-style noise on the run signal and timers that hold the event loop open serving no purpose once their race is lost. Fix: track the deadline sleep with an `AbortController`/cancel handle and abort it as soon as `Promise.race` settles on a real completion (or reuse a single deadline timer across re-entries). Low severity but a real leak.
