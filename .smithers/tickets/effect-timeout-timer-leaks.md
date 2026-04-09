# Fix timeout and heartbeat timer leaks with Effect.timeout

## Problem

`compute-task-bridge.ts` (lines 557-584) uses `Promise.race` + `setTimeout` for
task timeouts. The `setTimeout` timer is never cleaned up when the compute
promise resolves first, leaking timer handles and closures.

Similarly, heartbeat timeout management in `compute-task-bridge.ts` (lines
404-457) and `engine/index.ts` (lines 2370-2395) uses `setInterval` with 8
mutable state flags (`heartbeatClosed`, `taskCompleted`, `taskExecutionReturned`,
`heartbeatTimeoutTriggered`, etc.) and manual `clearInterval` in `finally`.

### Specific leaks

1. **Timeout timer**: `setTimeout` in `Promise.race` — losing Promise rejection
   is unhandled and may trigger `unhandledRejection`
2. **Heartbeat interval**: If exception occurs between `setInterval` and `finally`
   block, the interval leaks
3. **8 mutable flags**: Error-prone coordination between heartbeat and task state

## Proposed solution

1. Replace `Promise.race + setTimeout` with `Effect.timeout(Duration.millis(...))`
   which cleans up automatically via fiber interruption
2. Replace heartbeat `setInterval` with a fiber watchdog:
   ```typescript
   const watchdog = Effect.repeat(
     checkHeartbeat,
     Schedule.spaced(HEARTBEAT_CHECK_MS)
   );
   Effect.race(taskEffect, watchdog);
   ```
3. Eliminate mutable flags — fiber interruption handles cleanup

## Severity

**MAJOR** — Timer leaks in high-throughput scenarios. The code already runs
inside an Effect context, making this a straightforward migration.

## Files

- `src/effect/compute-task-bridge.ts`
- `src/engine/index.ts` (heartbeat timeout in `legacyExecuteTask`)
