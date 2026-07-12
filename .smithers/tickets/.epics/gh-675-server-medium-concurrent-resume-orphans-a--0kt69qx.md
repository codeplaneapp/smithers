# 🐛 server: [medium] concurrent resume orphans a live run — TOCTOU in resumeRunIfNeeded / startRun

GitHub: https://github.com/smithersai/smithers/issues/675

_via ultracode (Opus multi-agent) review_

## Summary
Under concurrent resume of the same `runId`, the gateway's in-memory run registry is corrupted: one resume's record (and AbortController) is overwritten, and the first-settling engine promise's `.finally` deletes the map entry owned by the still-driving resume — leaving a live run untracked and un-cancellable.

## Locations
- `packages/server/src/gateway.js:4523` — CONFLICT guard `if (!options?.resume && this.activeRuns.has(runId))` exempts resume.
- `packages/server/src/gateway.js:4536-4537` — `runRegistry.set` / `activeRuns.set` run synchronously *before* startRun's first `await` (`loadEngineRuntime` at 4562); resume unconditionally overwrites any existing record.
- `packages/server/src/gateway.js:4641` — `.finally` does `for (const m of [runRegistry, activeRuns, inflightRuns]) m.delete(runId)` — a delete-by-key with no identity check.
- `packages/server/src/gateway.js:4652-4667` — `resumeRunIfNeeded`: `activeRuns.has` (4654) → `await adapter.getRun` (4658, yields) → `await startRun(resume:true)` (4665). Check-then-act with no in-flight-resume dedup.

## Failure scenario
Run R is parked (`waiting-timer`/`waiting-quota`). The timer sweep (`resumeRunIfNeeded` at 4422/4476) and a concurrent signal/approval path (`resumeRunInBackground`/`resumeRunIfNeeded` at 7034/6398/6908/7060) both target R:
1. Both read `activeRuns.has(R) === false`.
2. Both yield at `await adapter.getRun(R)`.
3. Both call `startRun(R, {resume:true})`; the resume-exempt guard never fires. The second call's synchronous prologue overwrites `activeRuns`/`runRegistry` with its own record, orphaning the first record's AbortController.
4. The first engine promise (losing the engine's durable lease) settles fast; its `.finally` deletes R from all three maps — including the second, still-driving resume's entry.

R is now executing but untracked: `cancel` can't find it, the CONFLICT guard can't fire, and the next timer sweep sees `activeRuns.has(R) === false` and re-drives the already-active run. `timerSweepInFlight` does not help — it only guards sweep-vs-sweep, not sweep-vs-signal.

## Why it matters
This is exactly the orphaning the CONFLICT guard (comment at 4517-4522) was added to prevent; the resume exemption reopens it under concurrent resume, and the gateway loses the ability to cancel or track a live run and can re-drive an already-active run.

## Fix
Two independent hardenings: (a) dedup in-progress resumes for the same runId (e.g. gate on `inflightRuns`/a per-runId resume promise so only one `startRun(resume)` proceeds); and (b) make the `.finally` cleanup identity-scoped — `if (this.activeRuns.get(runId) === record) this.activeRuns.delete(runId)` (same for the other maps) — so a settling promise never evicts a record it does not own.
