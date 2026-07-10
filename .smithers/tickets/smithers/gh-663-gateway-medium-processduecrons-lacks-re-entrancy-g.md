# 🐛 gateway: [medium] processDueCrons lacks re-entrancy guard, double-fires a due cron under await latency

GitHub: https://github.com/smithersai/smithers/issues/663

_via ultracode (Opus multi-agent) review_

## Summary
`Gateway.processDueCrons` has no overlap guard and fires a due cron (`startRun`) before advancing `nextRunAtMs`, so a second scheduler tick can trigger the same scheduled fire twice (two distinct runs).

## References
- `packages/server/src/gateway.js:4075` — `setInterval(() => { void this.processDueCrons(); ... }, intervalMs)` (interval `>=1000ms`), fire-and-forget every tick.
- `packages/server/src/gateway.js:4280` — `processDueCrons`: no re-entrancy guard.
- `packages/server/src/gateway.js:4299` — due-skip check (`nextRunAtMs > now`).
- `packages/server/src/gateway.js:4308` — `await this.startRun(...)` runs BEFORE...
- `packages/server/src/gateway.js:4313` — `await adapter.updateCronRunTime(...)` advances `nextRunAtMs`.
- `packages/server/src/gateway.js:4562` — `startRun` awaits `loadEngineRuntime()` (memoized dynamic engine import).
- `packages/server/src/gateway.js:4523` — `startRun` CONFLICT guard keys on `runId`; cron uses a fresh `runId` per fire, so it cannot dedupe.
- Contrast `packages/server/src/gateway.js:4381-4384` — `processDueTimers` guards overlap with `this.timerSweepInFlight`.
- No DB-side dedup: `packages/db/src/adapter.js:3079` (`listCrons` plain SELECT), `:3090` (`updateCronRunTime` plain UPDATE) — no atomic claim/lock.

## Failure scenario
An autostarted daemon owns only a cron schedule (engine not yet imported). The cron comes due. Tick 1 enters `processDueCrons`, passes the skip check, and `await this.startRun(...)` blocks on the cold `import("@smithers-orchestrator/engine")` (can exceed the 1s interval on a cold/contended box). Before `updateCronRunTime` advances `nextRunAtMs`, tick 2 fires `processDueCrons`; the same cron still has `nextRunAtMs <= now`, passes the skip check, and calls `startRun` again with a new `runId`. Result: two runs for one scheduled fire.

## Why it matters
Scheduled workflows execute twice, wasting compute/quota and causing duplicate side effects (duplicate agent work, duplicate external calls). The missing guard mirrors `processDueTimers`' `timerSweepInFlight` and looks like a simple omission.

## Fix
Wrap `processDueCrons` in an in-flight guard mirroring `timerSweepInFlight`, and/or call `updateCronRunTime` to advance `nextRunAtMs` before `startRun`.
