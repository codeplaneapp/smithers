# Convert engine run loop to Effect structured concurrency

## Problem

The core workflow scheduler loop in `src/engine/index.ts` (lines 4180-5126) is a
bare `while(true)` with raw `async/await`, manual `setInterval`/`setTimeout` for
heartbeats and cancellation polling, `Promise.race` for wakeups, and a manual
`Set<Promise<void>>` for inflight task tracking. This is exactly what Effect's
fiber model was designed to replace.

### Specific issues

1. **Run supervisor** (`startRunSupervisor`, lines 1488-1555) uses `setInterval`
   for heartbeats and a `while + Bun.sleep` loop for cancel polling. If the
   supervisor crashes between polls, the heartbeat interval leaks.

2. **`continueRunAsNew`** (lines 1019-1307) manually runs `BEGIN IMMEDIATE` /
   `COMMIT` / `ROLLBACK`, duplicating the existing `withTransactionEffect` and
   bypassing its retry, rollback metrics, and fiber-safe turn acquisition.

3. **Fire-and-forget metrics** — 15+ instances of
   `void runPromise(Metric.increment(...))` spawn dangling Promises that can
   silently fail.

4. **Inflight tracking** — Module-level `Set<Promise<void>>` with manual
   `.finally()` cleanup. No structured concurrency guarantees.

5. **`legacyExecuteTask`** (lines 2188-3803) is a 1600-line raw async function
   with 8 mutable heartbeat flags, `setInterval`, manual abort wiring.

### Why this matters

The `cli/supervisor.ts` already demonstrates the correct Effect pattern with
`Effect.repeat(Schedule.spaced(...))`, log annotations, and structured error
handling. The engine loop should match it.

## Proposed solution

1. Convert the run loop to `Effect.gen` with:
   - `Effect.race`/`Effect.raceAll` instead of `schedulerWakeQueue.wait()`
   - `Effect.repeat(Schedule.spaced(...))` for heartbeat and cancel polling
   - `Effect.forkScoped` + `Fiber.join` instead of manual inflight Set
   - `Effect.acquireRelease` for caffeinate wake lock and hot controller
   - `Effect.interrupt` instead of manual `AbortController` plumbing
2. Replace `continueRunAsNew` raw SQL with `adapter.withTransactionEffect()`
3. Replace `void runPromise(Metric.increment(...))` with `yield* Metric.increment(...)` inside the Effect pipeline
4. Use `FiberSet`/`FiberMap` for inflight deduplication in `workflow-bridge.ts`

## Severity

**CRITICAL** — This is the heart of the durable workflow engine and the single
highest-impact change. Cascades fixes to supervisor, metrics, inflight tracking,
and `legacyExecuteTask`.

## Files

- `src/engine/index.ts`
- `src/effect/workflow-bridge.ts` (inflight Maps)
- `src/cli/scheduler.ts` (should also be converted to match `supervisor.ts`)
