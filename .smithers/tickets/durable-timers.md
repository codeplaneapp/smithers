# Durable timers

## Revision Summary

- Split rollout into one-shot timers first and recurring timers later.
- Added explicit engine work for extraction, waiting-state handling, cancellation,
  and wakeup delivery.
- Clarified that timer wakeups should plug into supervisor/poller infrastructure but
  not block on a future server command.
- Added a note to decide whether run-level status should reuse `waiting-event`
  initially or add a full `waiting-timer` surface everywhere.

## Problem

Smithers has no durable timer primitive. If a workflow needs to wait (e.g., "retry in
1 hour", "wait for market open", "poll every 30 minutes"), the process must stay alive
for the entire duration. There's no way to say "wake me up later" and exit cleanly.

Temporal solves this with a dedicated timer queue: `sleep(1h)` persists a
`TimerStarted` event, unloads the workflow from memory, and a server-side timer task
fires later to re-schedule the workflow.

## Proposal

Add a `<Timer>` component and a durable timer table.

Phase 1 should support one-shot timers only:

```tsx
<Timer id="cooldown" duration="1h" />
<Timer id="market-open" until="2026-04-03T09:30:00Z" />
```

### Semantics

1. When the scheduler encounters a Timer node, persist a row to `_smithers_timers`:
   `(runId, timerId, firesAtMs, firedAtMs, status)`
2. The node transitions to `waiting-timer` (new node state)
3. The engine can exit cleanly — the run becomes timer-blocked
4. A lightweight poller (cron tick, standalone supervisor, or shared background
   loop) checks for fired timers and auto-resumes the run

### Timer types

- **Duration**: `duration="30m"` — relative to when the timer is created
- **Absolute**: `until="2026-04-03T09:30:00Z"` — fires at a specific wall-clock time
- **Cron-like**: `every="15m"` — recurring timer inside a Loop (phase 2, after
  one-shot timers ship)

### Integration with existing machinery

- The existing cron scheduler (`_smithers_cron`) already polls on intervals — the
  timer poller can share that infrastructure
- `smithers ps` should show `waiting-timer` runs with the fire time
- `smithers why <run-id>` should report "waiting for timer X, fires in 23m"

## Additional Steps

1. Add a `<Timer>` component and DOM extraction metadata analogous to
   `WaitForEvent`/`Approval`.
2. Decide whether the run-level status surface reuses `waiting-event` initially or
   adds a new `waiting-timer` status everywhere (`RunStatus`, CLI filters, GUI
   badges, server summaries).
3. Add timer creation, fire, and cancel DB helpers.
4. Add a wakeup loop that marks due timers fired and resumes the owning run.
5. Cancel pending timers when a run is cancelled or permanently failed.
6. Teach `ps`, `inspect`, and `why` to include timer metadata.
7. Add recurring `every=` timers only after one-shot timer semantics are stable.

### Schema addition

```sql
CREATE TABLE _smithers_timers (
  run_id TEXT NOT NULL,
  timer_id TEXT NOT NULL,
  fires_at_ms INTEGER NOT NULL,
  fired_at_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | fired | cancelled
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, timer_id)
);
```

## Verification requirements

### E2E tests

1. **Timer fires and run resumes** — Create a workflow with `<Timer duration="1s" />`,
   run it, assert run transitions to `waiting-timer`, wait 1.5s, trigger the supervisor
   poll, assert run resumes and completes. Assert `_smithers_timers` row has
   `status='fired'` and `fired_at_ms` is set.

2. **Absolute timer** — Create `<Timer until={futureDate} />` where futureDate is 1s
   from now. Same flow: run → waiting-timer → poll → resumed → finished.

3. **Timer cancellation** — Start a workflow with a Timer, cancel the run while
   waiting. Assert timer status becomes `cancelled`, run status becomes `cancelled`.

4. **Timer in a Loop** — `<Loop until={condition}><Timer duration="500ms" /><Task ...>`
   Assert each loop iteration independently waits and fires. Assert iteration counter
   increments correctly across timer boundaries.

5. **Multiple timers in one workflow** — Two parallel branches each with a timer at
   different durations. Assert both fire independently and the run only completes when
   both branches finish.

6. **Process exit and restart** — Start a workflow with a timer, kill the process, start
   a new supervisor process, assert the timer is picked up and the run resumes after it
   fires.

7. **`smithers ps` shows timer info** — Assert `ps` output includes `waiting-timer`
   status and the fire time for timer-blocked runs.

8. **`smithers why` integration** — Assert `why` reports "waiting for timer X, fires
   in Ns" for timer-blocked runs.

### Corner cases

9. **Timer in the past** — `<Timer until="2020-01-01T00:00:00Z" />` (already expired).
   Should fire immediately on next poll, not block.

10. **Timer with 0 duration** — `<Timer duration="0s" />`. Should fire immediately.

11. **Very long timer** — `<Timer duration="365d" />`. Assert it persists correctly
    (fires_at_ms is a valid future timestamp) and doesn't overflow.

12. **Duplicate timer IDs** — Two `<Timer id="same" />` in the same workflow. Should
    error at render time, not silently overwrite.

### Size/input limits

13. **Timer ID length** — Timer IDs longer than 256 chars should be rejected.
14. **Max timers per run** — Assert behavior with 1000 timers in a single run (should
    work but be tested for performance).

## Observability

### New events
- `TimerCreated { runId, timerId, firesAtMs, timerType: "duration"|"absolute", timestampMs }`
- `TimerFired { runId, timerId, firesAtMs, firedAtMs, delayMs, timestampMs }`
- `TimerCancelled { runId, timerId, timestampMs }`

### New metrics
- `smithers.timers.created` (counter) — timers created
- `smithers.timers.fired` (counter) — timers that fired
- `smithers.timers.cancelled` (counter) — timers cancelled
- `smithers.timers.pending` (gauge) — currently pending timers
- `smithers.timers.delay_ms` (histogram, durationBuckets) — actual fire time minus
  scheduled fire time (measures poll latency)

### Logging
- `Effect.withLogSpan("timer:create")`, `Effect.withLogSpan("timer:fire")`
- Annotate with `{ runId, timerId, firesAtMs }`

## Codebase context

### Smithers files
- `src/RunStatus.ts:1-7` — Add `"waiting-timer"` to the RunStatus union
- `src/db/internal-schema.ts` — Add `_smithers_timers` table definition
- `src/engine/index.ts:381-382` — `RUN_HEARTBEAT_MS` / `RUN_HEARTBEAT_STALE_MS`
  constants, nearby is where timer poll would live
- `src/engine/index.ts:697-708` — Heartbeat interval setup; timer check can share
  this pattern
- `src/cli/scheduler.ts:21-62` — Cron poll loop (`tick()`); timer firing should be
  added here or share the same `setTimeout` loop
- `src/components/Approval.ts` — Reference for how a blocking component is built
  (Approval blocks on `waiting-approval`; Timer blocks on `waiting-timer`)
- `src/components/Ralph.ts:1-22` — Loop component; `continueAsNewEvery` timer
  integration point
- `src/SmithersEvent.ts` — Add new timer event types to the union
- `src/effect/metrics.ts` — Add timer metrics, wire into `trackEvent()` switch

### Temporal reference
- `temporal-reference/service/history/workflow/timer_sequence.go` — How Temporal
  manages ordered timer queues and deduplication
- `temporal-reference/service/history/workflow/timer_sequence_test.go:66-127` —
  Test patterns: `TestCreateNextUserTimer_AlreadyCreated_*` for timer dedup
- `temporal-reference/service/history/timer_queue_active_task_executor.go` — How
  the timer queue executor fires timers and creates transfer tasks
- `temporal-reference/service/history/timer_queue_active_task_executor_test.go:196` —
  `TestProcessUserTimerTimeout_Fire`: mocks time source, adds timer, verifies firing
- `temporal-reference/service/history/workflow/state_machine_timers_test.go:17-56` —
  `TestTrackStateMachineTimer_MaintainsSortedSlice`: tests timer ordering

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

- **`@effect/workflow`** — `DurableClock.sleep()` replaces the custom timer table and poller entirely
- **`effect`** core — `Effect.gen`, `Effect.annotateLogs`, `Effect.withLogSpan`, `Schedule` for recurring timers (phase 2)

### Key mapping

The `<Timer>` JSX component is a user-facing boundary (exempt from Effect), but it compiles down to a `DurableClock.sleep()` call in the engine. This is a direct 1:1 mapping:

```typescript
// <Timer id="cooldown" duration="1h" /> compiles to:
yield* DurableClock.sleep({ name: "cooldown", duration: "1 hour" })

// <Timer id="market-open" until="2026-04-03T09:30:00Z" /> compiles to:
const delay = new Date("2026-04-03T09:30:00Z").getTime() - Date.now()
yield* DurableClock.sleep({ name: "market-open", duration: `${delay} millis` })
```

**No custom `_smithers_timers` table is needed.** `@effect/workflow` already handles durable timer persistence internally via its execution journal. The timer poller from the proposal is replaced by the workflow engine's built-in clock scheduling — when a `DurableClock.sleep()` expires, the workflow engine automatically resumes the workflow.

### Effect patterns to apply

```typescript
import { DurableClock } from "@effect/workflow"
import { Effect, Schedule } from "effect"

// One-shot timer in a workflow activity
const timerStep = Effect.gen(function*() {
  yield* Effect.annotateLogs({ runId, timerId })
  yield* Effect.withLogSpan("timer:create")(
    Effect.logInfo("Timer created, sleeping")
  )
  yield* DurableClock.sleep({ name: timerId, duration: parsedDuration })
  yield* Effect.withLogSpan("timer:fire")(
    Effect.logInfo("Timer fired, resuming")
  )
})

// Phase 2: Recurring timer via Schedule (for <Timer every="15m" />)
const recurringTimer = Effect.gen(function*() {
  yield* Effect.repeat(
    loopBody,
    Schedule.spaced("15 minutes")
  )
})
```

### Smithers Effect patterns to follow

- `src/effect/runtime.ts` — Use the custom runtime layer for all timer Effect execution
- `src/effect/metrics.ts` — Wire timer metrics (`smithers.timers.created`, `smithers.timers.fired`, etc.) into `trackEvent()` switch; use the existing histogram/counter helpers
- `src/effect/logging.ts` — Annotate timer spans with `{ runId, timerId, firesAtMs }`
- Existing `Effect.withLogSpan` and `Effect.annotateLogs` patterns used throughout the engine

### What this eliminates

- The `_smithers_timers` SQL table from the proposal — workflow engine journal handles persistence
- The timer poller/wakeup loop — workflow engine's clock scheduler handles wakeups
- The `withSqliteWriteRetry` wrapper for timer writes — no direct DB writes needed

### Reference files

- `/Users/williamcory/effect-reference/packages/workflow/src/DurableClock.ts` — `DurableClock.sleep()` API definition
- `/Users/williamcory/effect-reference/packages/workflow/src/WorkflowEngine.ts` — Engine handles timer scheduling and persistence
- `/Users/williamcory/effect-reference/packages/workflow/test/WorkflowEngine.test.ts` — Test patterns for durable timers in workflows
