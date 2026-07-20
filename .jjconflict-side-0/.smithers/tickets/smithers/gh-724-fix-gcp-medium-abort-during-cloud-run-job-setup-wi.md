# 🐛 fix(gcp): [medium] abort during Cloud Run job setup window is silently ignored, run never cancels

GitHub: https://github.com/smithersai/smithers/issues/724

_via ultracode (Opus multi-agent) review_

`run()` never cancels the Cloud Run execution when the abort arrives during the job-setup window, because the abort listener is attached to an already-aborted signal (which per spec never fires).

**Location**: `packages/gcp/src/createGcpCloudRunJobsSandboxRunner.js`
- Only early abort guard: line 220 (before the awaits).
- `await ensureJob(timeoutSec)` line 227 → createJob LRO `await operation.promise()` at line 204 (the multi-second window).
- Abort listener attached at lines 288-293 (`signal.addEventListener("abort", onAbort, { once: true })`) with **no** `signal.aborted` re-check.

**Failure scenario**: `createGcpSandboxProvider` with `createJob: true`. The createJob LRO takes ~20s; `request.signal`/`exec.signal` aborts 5s in (user cancel or tool timeout). Execution is past line 220 and blocked inside `await ensureJob(...)`, so no listener exists yet. When setup finishes, the Promise executor (line 283) adds the abort listener to the already-aborted signal — per the DOM spec it never fires. `onAbort` (line 289) never runs, so `cancelExecution()` is never called and the promise only settles when `operation.promise()` (line 284) resolves. The run blocks for the full execution/timeout, and the Cloud Run execution is neither cancelled (no `operation.cancel()`, no `cancelExecution`/`deleteExecution`) nor rejected promptly — the exact "block until Cloud Run finished even after an abort" failure the comment at lines 277-279 claims to prevent.

**Why it matters**: Cancellation must stop in-flight remote work. This leaks a running (billable) Cloud Run execution and leaves a cancelled/timed-out run hanging until the remote job finishes on its own. The test at `tests/createGcpCloudRunJobsSandboxRunner.test.js:247` masks the bug by aborting only after the listener attaches.

**Fix**: inside the executor (or immediately after `addEventListener`), re-check `signal?.aborted` and, if already aborted, call `cancelExecution()` and reject.
