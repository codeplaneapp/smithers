# 🐛 driver: abort during a deadline wait rejects run() with AbortError instead of returning a cancelled RunResult

GitHub: https://github.com/smithersai/smithers/issues/580

**What happens**
In `packages/driver/src/WorkflowDriver.js`, `nextCompletionDecision` races in-flight tasks against `sleepWithAbort(deadlineMs, signal).then(() => null)` (:520). `sleepWithAbort` rejects with `AbortError` when the run signal aborts (:211-230). The `await Promise.race(racers)` (:522) is inside a try/finally with no catch, so the AbortError propagates out of `nextCompletionDecision` and out of `run()` (:303, no try/catch around the loop) as a promise rejection.

The same pattern exists in the `RetryBackoff` wait: `await sleepWithAbort(reason.waitMs, ...)` at :622 is uncaught, so its `aborted → cancelRun()` check on the next line is unreachable on abort.

**Why it's wrong / failure scenario**
Abort a run while it is waiting on a retry-backoff/timer deadline: instead of the documented `{ status: "cancelled" }` RunResult, `run()` rejects with AbortError, and the driver skips the `cancelRun()` bookkeeping (`session.cancelRequested()`) that every other abort site performs (:311, :329, :533, :546). Task-executor promises never reject (errors are wrapped into settled objects, :483-491), so the sleep racer is the only rejection source — this path is the lone inconsistency.

**Expected behavior**
Abort during a deadline or backoff wait resolves to `this.cancelRun()` like every other abort site.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
