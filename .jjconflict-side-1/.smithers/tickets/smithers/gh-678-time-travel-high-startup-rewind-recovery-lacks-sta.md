# 🐛 time-travel: [high] startup rewind recovery lacks staleness guard — clobbers a healthy in-flight rewind from another process

GitHub: https://github.com/smithersai/smithers/issues/678

_via ultracode (Opus multi-agent) review_

## Summary
Startup rewind-audit recovery marks EVERY `in_progress` audit row `partial` and flips its run to `needs_attention` with no staleness threshold or liveness check, so a concurrent process boot can corrupt a healthy, in-flight rewind driven by another process.

## Where
- `packages/time-travel/src/recoverInProgressRewindAudits.js:19-24` — blanket `SELECT ... WHERE result = 'in_progress'`; `timestamp_ms` is selected but used only for `duration_ms` (line 34), never to filter by age. No liveness check.
- `packages/time-travel/src/recoverInProgressRewindAudits.js:35-54` — unconditionally rewrites each row to `partial` and calls `updateRun(runId, { status: 'needs_attention', runtimeOwnerId: null, heartbeatAtMs: null, errorJson })`.
- `packages/time-travel/src/jumpToFrame.js:571` — writes the durable `in_progress` row BEFORE sandbox reverts + the truncation transaction; only marks it terminal in `finally` at `jumpToFrame.js:1013` (a multi-second window while VCS reverts run).
- `apps/cli/src/index.js:2336-2341` — `recoverRewindAuditsAtStartup` runs unconditionally on every `smithers up` boot against the shared workspace DB.

## Failure scenario
1. Process A is mid-rewind of run X: it has committed the durable `in_progress` audit row (jumpToFrame.js:571) and is reverting sandboxes.
2. Process B runs `smithers up` for any run in the same workspace. Its startup recovery scans the whole DB, sees X's fresh `in_progress` row, rewrites it to `partial`, and calls `updateRun(X, { status: 'needs_attention', runtimeOwnerId: null, ... })`.
3. A then commits its transaction setting X back to `running`. The two writes race: X is left either falsely flagged `needs_attention`, or with a `partial` audit row for a rewind that actually succeeded.

The in-process rewind lock (`acquireRewindLock`, in-memory Map) cannot coordinate across processes — jumpToFrame.js:513-517 states this explicitly.

## Why it matters
An unrelated process boot can corrupt a healthy in-progress rewind and mislabel the run as failed/needs-attention. The package already ships `isRunLikelyLive` (used by jumpToFrame at :521 to refuse rewinding a live run) and the audit row already carries `timestamp_ms`. Recovery should require a staleness threshold on `timestamp_ms` (jumpToFrame requires the run be non-live before rewinding, so a run-liveness check alone is insufficient — an age window on the audit row is the correct guard).
