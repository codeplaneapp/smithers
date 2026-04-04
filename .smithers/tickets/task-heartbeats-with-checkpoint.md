# Task-level heartbeats with checkpoint data

## Revision Summary

- Split the feature into runtime API design, persistence, timeout detection, and
  agent/sandbox integration.
- Added an explicit note that `ctx.heartbeat()` / `ctx.lastHeartbeat` do not exist
  yet and must be introduced as a new task runtime API.
- Added agent-side integration work so CLI agents and remote workers can actually
  emit heartbeats.
- Clarified that sandbox depends on this ticket, but local task heartbeats can ship
  first.

## Problem

Smithers has a run-level heartbeat (1s interval, 5s staleness), but it carries no
payload and applies to the whole run, not individual tasks. If a long-running task
(agent doing a 20-minute code review, or a remote Sandbox task) crashes at 80%
progress, the retry starts from 0%.

Temporal activities send heartbeats with arbitrary checkpoint data. On retry, the new
worker receives `LastHeartbeatDetails` and resumes from the checkpoint — not from
scratch.

This becomes critical with `<Sandbox>` remote execution: you need to know if a remote
machine is alive, and if it crashes, you want to resume from its last checkpoint.

## Proposal

Add per-task heartbeats with checkpoint data.

This requires a new task runtime API; current Smithers workflow context does not yet
expose `heartbeat()` or `lastHeartbeat`.

### From workflow/agent code

```ts
// API name TBD, but this should be available inside a running task/agent callback:
runtime.heartbeat({ progress: 75, cursor: "page-42", partialResults: [...] });
```

### Schema addition

```sql
ALTER TABLE _smithers_attempts ADD COLUMN heartbeat_at_ms INTEGER;
ALTER TABLE _smithers_attempts ADD COLUMN heartbeat_data_json TEXT;
```

### On retry

The checkpoint data is passed to the next attempt:

```ts
// In task runtime / agent context:
const lastCheckpoint = runtime.lastHeartbeat; // { progress: 75, cursor: "page-42", ... }
if (lastCheckpoint) {
  // Resume from checkpoint instead of starting over
}
```

### Staleness detection

- Per-task heartbeat timeout (configurable, default 60s for local, 120s for Sandbox)
- If a task hasn't heartbeated within its timeout, mark as failed and schedule retry
- `smithers why` should report "task X hasn't heartbeated in 90s (timeout: 60s)"

### Integration with Sandbox

Remote sandbox tasks heartbeat over the network. The orchestrator tracks liveness
per-task, not just per-run. If the remote machine goes down, the specific task is
retried (possibly on a different machine) with its last checkpoint.

## Rollout phases

### Phase 1: Local task heartbeat API

- New runtime API for compute functions and agent execution
- DB persistence of latest heartbeat timestamp/payload
- Retry handoff of the last heartbeat data

### Phase 2: Timeout detection

- Per-task timeout watchers/poller
- `why`/diagnostic integration

### Phase 3: Remote/sandbox integration

- Network-delivered heartbeats
- Cross-process checkpoint resume

## Additional Steps

1. Extend the task runtime object so tasks/agents can call `heartbeat()` safely.
2. Add adapter methods for updating heartbeat timestamp/data on the current attempt.
3. Read the previous attempt's heartbeat into the next attempt's runtime before
   execution starts.
4. Add JSON-serializability and size validation at heartbeat write time.
5. Throttle heartbeat writes and define latest-write-wins semantics.
6. Teach supported agents and sandbox workers how to emit heartbeats.
7. Ensure heartbeat calls after completion are ignored cleanly.

## Verification requirements

### E2E tests

1. **Heartbeat persists and is readable** — Task calls `ctx.heartbeat({ progress: 50 })`,
   assert `_smithers_attempts.heartbeat_data_json` is set and `heartbeat_at_ms` is
   recent.

2. **Checkpoint passed on retry** — Task heartbeats `{ cursor: "page-5" }`, then fails.
   On retry, assert `ctx.lastHeartbeat` contains `{ cursor: "page-5" }`. Task uses
   checkpoint to skip pages 1-5 and succeeds.

3. **Multiple heartbeats overwrite** — Task heartbeats 3 times with increasing progress
   (25, 50, 75). Assert only the latest (75) is persisted. Previous values are not
   retained.

4. **Heartbeat timeout triggers failure** — Task has `heartbeatTimeout: 2000` (2s).
   Task stops heartbeating. After 2s, assert task is marked failed and retry is
   scheduled.

5. **No heartbeat = no timeout** — Task without heartbeat timeout configured runs for
   10s without heartbeating. Assert no timeout occurs.

6. **Heartbeat keeps task alive** — Task has `heartbeatTimeout: 1000`. Task heartbeats
   every 500ms for 5s total. Assert task is NOT timed out despite running for 5x the
   timeout.

7. **Checkpoint data survives process crash** — Task heartbeats, then process is killed.
   On resume, retry receives the checkpoint data from the DB.

8. **`smithers why` integration** — Task hasn't heartbeated in 90s with 60s timeout.
   Assert `why` reports the heartbeat staleness.

### Corner cases

9. **Empty checkpoint** — `ctx.heartbeat({})`. Should persist and be retrievable.

10. **Large checkpoint data** — `ctx.heartbeat({ data: "x".repeat(1_000_000) })`.
    Should work up to 1MB. Above 1MB, should reject with a clear error.

11. **Non-JSON-serializable checkpoint** — `ctx.heartbeat({ fn: () => {} })`. Should
    throw a validation error at heartbeat time, not silently drop.

12. **Heartbeat after task completion** — Calling `ctx.heartbeat()` after the task has
    already returned output. Should be a no-op (not an error).

13. **First attempt has no checkpoint** — On first attempt, `ctx.lastHeartbeat` is
    `null`. Should not throw.

### Size limits

14. **Max heartbeat payload**: 1MB JSON. Reject larger payloads with
    `HEARTBEAT_PAYLOAD_TOO_LARGE` error.
15. **Heartbeat frequency**: Throttle to max 1 heartbeat per 500ms per task. Excess
    heartbeats are batched (latest wins).

## Observability

### New events
- `TaskHeartbeat { runId, nodeId, iteration, attempt, hasData: boolean, dataSizeBytes, timestampMs }`
- `TaskHeartbeatTimeout { runId, nodeId, iteration, attempt, lastHeartbeatAtMs, timeoutMs, timestampMs }`

### New metrics
- `smithers.heartbeats.total` (counter) — heartbeats received
- `smithers.heartbeats.timeout_total` (counter) — heartbeat timeouts triggered
- `smithers.heartbeats.data_size_bytes` (histogram, sizeBuckets) — checkpoint payload
  size distribution
- `smithers.heartbeats.interval_ms` (histogram, fastBuckets) — time between
  consecutive heartbeats from same task

### Logging
- `Effect.withLogSpan("heartbeat:record")`, `Effect.withLogSpan("heartbeat:timeout")`
- Annotate with `{ runId, nodeId, attempt, dataSizeBytes }`

## Codebase context

### Smithers files
- `src/db/internal-schema.ts:55-70` — `_smithers_attempts` table; add
  `heartbeat_at_ms` and `heartbeat_data_json` columns here
- `src/engine/index.ts:381-382` — `RUN_HEARTBEAT_MS` constant; task-level heartbeat
  timeout check should be a similar interval-based pattern
- `src/engine/index.ts:697-708` — Run heartbeat interval; task heartbeat watcher can
  be a similar `setInterval` per in-flight task
- `src/engine/index.ts:1411-2600` — `executeTask` function; `ctx.heartbeat()` API
  needs to be injected into the task execution context here
- `src/engine/index.ts:2460-2493` — Task completion path; read last attempt's
  heartbeat data and pass as `ctx.lastHeartbeat` to next attempt
- `src/db/write-retry.ts:86-155` — `withSqliteWriteRetry`; heartbeat writes should
  use this wrapper

### Temporal reference
- `temporal-reference/tests/activity_test.go:380` —
  `TestActivityHeartBeatWorkflow_Success`: records 10 heartbeats at 10ms intervals,
  asserts payload roundtrip
- `temporal-reference/tests/activity_test.go:808` —
  `TestActivityHeartBeatWorkflow_Timeout`: activity sleeps past heartbeat timeout,
  asserts `ErrActivityTaskNotFound`
- `temporal-reference/tests/activity_test.go:1181` —
  `TestActivityHeartbeatDetailsDuringRetry`: **key pattern** — first attempt heartbeats
  then times out, subsequent retries access `activity.GetHeartbeatDetails()`, polls
  `DescribeWorkflowExecution()` to verify `PendingActivities[0].HeartbeatDetails`
  persists across 3 retries

## Effect.ts architecture

### Boundary rule

All internal code MUST stay in Effect. Never call `runPromise()` or `runSync()` inside
internal modules. The only places allowed to break out of Effect into promises are:

- **CLI command handlers** — the outermost `run(c)` function in `src/cli/index.ts`
- **HTTP route handlers** — the outermost handler in `src/server/index.ts`
- **JSX component boundaries** — React/Solid components that call into Effect services
- **Test entry points** — `Effect.runPromise` in test files

Everything else — DB queries, engine logic, transport calls, validation, metrics,
logging — must compose as `Effect<A, E, R>` and flow through the Effect pipeline.
Do not wrap Effect code in `runPromise()` to get a Promise, then re-wrap that Promise
in `Effect.tryPromise()`. Keep the Effect chain unbroken.

**Rule:** ALL internal code must use Effect.ts. Only user-facing API boundaries (JSX components, React GUI) are exempt.

### Packages

- **`@effect/workflow`** — `Activity.make()` wraps task execution with built-in retry and checkpoint support
- **`effect`** core — `Effect.gen`, `Effect.annotateLogs`, `Effect.withLogSpan`, `Schedule` for heartbeat intervals, `Schema` for checkpoint validation

### Key mapping

Each task execution should be wrapped in an `Activity.make()`. The heartbeat mechanism integrates with the Activity's retry/checkpoint system:

```typescript
import { Activity } from "@effect/workflow"
import { Effect, Schedule, Schema } from "effect"

// Define the task as an Activity with checkpoint support
const ScanTask = Activity.make({
  name: "scan-codebase",
  success: Schema.Struct({ vulnerabilities: Schema.Array(Schema.String) }),
  error: Schema.String,
  execute: Effect.gen(function*() {
    // Access last checkpoint from previous attempt (if retrying)
    const lastCheckpoint = yield* Activity.currentAttempt
    // lastCheckpoint contains heartbeat data from the failed attempt

    yield* Effect.annotateLogs({ runId, nodeId, attempt: lastCheckpoint.attempt })

    // Heartbeat with checkpoint data on a schedule
    const heartbeat = (data: unknown) =>
      Effect.withLogSpan("heartbeat:record")(
        Activity.heartbeat(data)
      )

    // Do work, periodically heartbeating
    yield* heartbeat({ progress: 25, cursor: "page-1" })
    // ... more work ...
    yield* heartbeat({ progress: 75, cursor: "page-42" })

    return { vulnerabilities: [...] }
  })
})
```

### Heartbeat interval as an Effect Schedule

```typescript
import { Effect, Schedule } from "effect"

// Heartbeat interval: throttled to max 1 per 500ms, using Schedule
const heartbeatSchedule = Schedule.spaced("500 millis")

// Heartbeat timeout detection: use Schedule for polling
const heartbeatTimeoutCheck = Effect.gen(function*() {
  yield* Effect.withLogSpan("heartbeat:timeout")(
    Effect.repeat(
      checkHeartbeatStaleness({ runId, nodeId, timeoutMs: 60_000 }),
      Schedule.spaced("1 second")
    )
  )
})
```

### Retry with checkpoint handoff

```typescript
// Activity retry with checkpoint data carried to next attempt
const retriableTask = Activity.make({
  name: "resumable-scan",
  success: ScanResult,
  error: ScanError,
  execute: Effect.gen(function*() {
    const attempt = yield* Activity.currentAttempt
    const checkpoint = attempt.lastHeartbeat // { progress: 75, cursor: "page-42" }

    if (checkpoint) {
      yield* Effect.logInfo(`Resuming from checkpoint: ${checkpoint.cursor}`)
      // Skip already-processed work
    }

    // ... continue from checkpoint ...
  })
})

// Wire retry policy as a Schedule
const retryPolicy = Schedule.exponential("1 second").pipe(
  Schedule.compose(Schedule.recurs(3))
)
```

### Effect patterns to apply

- Wrap each task execution in `Activity.make()` so the workflow engine manages retries and checkpoint persistence
- Use `Activity.currentAttempt` to access `lastHeartbeat` data from a previous failed attempt
- Use `Schedule.spaced("500 millis")` for heartbeat throttling instead of raw `setInterval`
- Use `Effect.withLogSpan("heartbeat:record")` and `Effect.withLogSpan("heartbeat:timeout")` for observability
- Checkpoint data validation via `Schema` at heartbeat write time

### Smithers Effect patterns to follow

- `src/effect/runtime.ts` — Use the custom runtime layer for Activity execution
- `src/effect/metrics.ts` — Wire heartbeat metrics (`smithers.heartbeats.total`, `smithers.heartbeats.timeout_total`, etc.) into `trackEvent()` switch
- `src/effect/logging.ts` — Annotate heartbeat spans with `{ runId, nodeId, attempt, dataSizeBytes }`
- `src/effect/task-runtime.ts` — Extend the task runtime to expose `heartbeat()` as an Effect-based API
- Follow the existing `fromPromise()` interop pattern in `src/effect/interop.ts` for bridging current heartbeat writes

### Reference files

- `/Users/williamcory/effect-reference/packages/workflow/src/Activity.ts` — `Activity.make()`, `Activity.currentAttempt`, heartbeat API
- `/Users/williamcory/effect-reference/packages/workflow/src/WorkflowEngine.ts` — How the engine manages Activity retries and checkpoints
- `/Users/williamcory/effect-reference/packages/workflow/test/WorkflowEngine.test.ts` — Test patterns for Activity heartbeat and retry
