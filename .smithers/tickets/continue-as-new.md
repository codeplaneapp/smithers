# Continue-as-new for long-running workflows

## Revision Summary

- Reworked lineage so it reuses the existing branch/timeline ancestry model instead
  of inventing a second source of truth.
- Split the feature into explicit `continueAsNew()` first and automatic loop-based
  continuation second.
- Added a transactional handoff requirement between the old run and the new run.
- Added missing work for state seeding, lineage-aware inspect/events output, and
  cache/output carry-forward.

## Problem

Long-running loops and agent daemons accumulate unbounded event history,
node/attempt records, and time-travel frames in SQLite. Ralph handles loop
iteration tracking, but the underlying storage grows linearly with iteration count.
There's no mechanism to "roll forward" a workflow — preserving its logical identity
while resetting the execution history.

Azure Durable Functions solves this with `ContinueAsNew()`: the orchestration
restarts from scratch with carried-over state, and the old history is archived.

## Proposal

Add an explicit `continueAsNew(state)` API callable from within a workflow. Automatic
loop-based continuation should be a second phase after the explicit mechanism is
stable.

### Semantics

1. Snapshot the current workflow state (inputs, loop counters, accumulated context)
2. Create a **new run** linked to the old one via the existing ancestry model
   (`_smithers_branches` or a shared continuation table)
3. Mark the old run as continued via terminal metadata and/or a dedicated event
4. Start the new run from the workflow entry point with the carried-over state
5. Old run's history remains queryable but stops growing

### API surface

**From workflow code:**
```tsx
<Loop id="daemon" until={false} continueAsNewEvery={1000}>
  {/* loop body */}
</Loop>
```

Or explicitly:
```ts
if (iteration > threshold) {
  yield* continueAsNew({ cursor, lastResult });
}
```

Automatic loop support can come later:

```tsx
<Loop id="daemon" until={false} continueAsNewEvery={1000}>
  {/* loop body */}
</Loop>
```

**Ancestry chain:**
```
$ smithers inspect abc123
Continued from: abc100 → abc050 → abc001 (original)
```

**CLI:**
- `smithers inspect` shows continuation lineage
- `smithers events` can follow the ancestry chain with `--follow-ancestry`

## Implementation notes

- Reuse the existing time-travel lineage model if possible instead of adding a second
  parent pointer directly on `_smithers_runs`
- Prefer an explicit continuation event plus metadata before expanding `RunStatus`
  unless operators truly need `continued` as a top-level status
- Ralph/Loop integration can trigger continuation when
  `iteration % continueAsNewEvery === 0`, but only after explicit continuation ships
- Old run's DB rows stay intact — no deletion, just a logical cutoff
- The new run's cache should be seeded with the carried-over state so it doesn't
  re-execute already-completed work

## Additional Steps

1. Define the carried-over state contract: input, loop counters, selected outputs,
   and any workflow-local continuation payload.
2. Create the new run and mark the old run as continued in one transactional
   handoff.
3. Emit a dedicated continuation event so `events`, `inspect`, and timeline views
   can render the lineage clearly.
4. Teach `inspect` and `events --follow-ancestry` to traverse the same lineage model
   used by time travel/forks.
5. Add guardrails for continuation storms, max chain depth, and operator visibility
   into the current active descendant.
6. After explicit continuation works, add `continueAsNewEvery` to `Loop`/`Ralph`.

## Verification requirements

### E2E tests

1. **Basic continue-as-new** — `<Loop until={false} continueAsNewEvery={5}>`. Run for
   12 iterations. Assert 3 runs created: run1 (iterations 0-4), run2 (5-9), run3
   (10-11). Assert run1 status="continued", run2 status="continued", run3
   status="finished" (or still running).

2. **State carries over** — Loop accumulates a counter. After continue-as-new, the
   counter value from the last iteration of run1 is available in the first iteration
   of run2.

3. **Ancestry chain** — `smithers inspect <run3>`. Assert output shows:
   "Continued from: run2 → run1 (original)".

4. **`parentRunId` column** — Assert `_smithers_runs.parent_run_id` is set correctly:
   run2.parentRunId = run1.runId, run3.parentRunId = run2.runId.

5. **Old run history stays queryable** — `smithers events <run1>`. Assert events from
   run1 are still accessible. `smithers node <nodeId> -r <run1>` still works.

6. **Cache seeding** — After continue-as-new, the new run has access to cached outputs
   from the old run. Assert no re-execution of already-completed tasks.

7. **`--follow-ancestry` flag** — `smithers events <run3> --follow-ancestry`. Assert
   events from all 3 runs are shown in chronological order.

8. **Explicit continue-as-new** — `yield* continueAsNew({ cursor: "abc" })` called
   from task code. Assert new run starts with the provided state.

### Corner cases

9. **Continue-as-new at iteration 0** — `continueAsNewEvery={1}`. Every iteration is a
   new run. Assert it works but warn about overhead.

10. **Continue-as-new with pending approval** — Loop hits approval gate, then
    continue-as-new threshold. Assert approval is resolved before continuation (don't
    orphan pending approvals).

11. **Very long chain** — 100 continuations (continueAsNewEvery=1, 100 iterations).
    Assert no stack overflow, no runaway DB growth. Ancestry query returns all 100.

12. **Continue-as-new + cancel** — Cancel a run that's about to continue-as-new.
    Assert cancellation wins, no new run created.

13. **Resume after continue-as-new crash** — Process dies during the continue-as-new
    transition (after creating run2 but before marking run1 as "continued"). On
    resume, assert either run1 re-continues or run2 is detected as the active run.

### Size limits

14. **Max carried-over state**: 10MB JSON. Above this, error with recommendation to
    reduce state or use external storage.
15. **Max ancestry chain depth**: No hard limit, but `inspect` should paginate chains
    longer than 100.

## Observability

### New events
- `RunContinuedAsNew { runId, newRunId, iteration, carriedStateSize, timestampMs }`

### New metrics
- `smithers.runs.continued_total` (counter) — continue-as-new transitions
- `smithers.runs.ancestry_depth` (histogram) — depth of continuation chains
- `smithers.runs.carried_state_bytes` (histogram, sizeBuckets) — size of state
  carried to new run

### Logging
- `Effect.withLogSpan("engine:continue-as-new")`
- Annotate with `{ runId, newRunId, iteration, carriedStateBytes }`
- Info: "Continuing run {runId} as {newRunId} at iteration {iteration}"

## Codebase context

### Smithers files
- `src/components/Ralph.ts:1-22` — Loop component. Add `continueAsNewEvery` prop
  here.
- `src/engine/scheduler.ts:166-178` — `buildPlanTree()` handles `smithers:ralph`
  nodes. The continue-as-new check goes here: when `iteration % continueAsNewEvery
  === 0`, trigger rollover instead of normal iteration.
- `src/engine/index.ts:2780-2948` — Run start/resume flow. Continue-as-new creates a
  new run using the same pattern as `runWorkflow()` but with carried-over state.
- `src/db/internal-schema.ts:20-40` — `_smithers_runs` table. Add `parent_run_id`
  column.
- `src/time-travel/types.ts` — Already has `parentRunId` and `parentFrameNo` in
  snapshot/branch schema. Continue-as-new can reuse this ancestry model.
- `src/RunStatus.ts:1-7` — Add `"continued"` to RunStatus union.

### Temporal reference
- `temporal-reference/tests/continue_as_new_test.go:39` —
  `TestContinueAsNewWorkflow`: **key reference**. Loops 10 times issuing
  CONTINUE_AS_NEW command. Each iteration: increments counter in payload, verifies new
  `RunId`, verifies `ContinuedExecutionRunId` points to previous, verifies
  `FirstExecutionRunId` is stable. Final check: `DescribeWorkflowExecution()` returns
  latest RunId.
- `temporal-reference/tests/continue_as_new_test.go:177` —
  `TestContinueAsNewRunTimeout`: sets 1s run timeout, after continue-as-new the
  timeout applies to the new run. Tests timeout fires on new run.
- `temporal-reference/service/history/workflow/mutable_state_impl.go` (around line
  5662) — `AddContinueAsNewEvent()`: creates new runID, preserves parent/root info,
  clears all pending activities/timers/signals, branches history tree.

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

- **`@effect/workflow`** — `Workflow.make()` and `WorkflowEngine.execute()` for creating new workflow executions with carried-over state
- **`effect`** core — `Effect.gen`, `Effect.annotateLogs`, `Effect.withLogSpan`, `Schema` for carried-over state validation

### Key mapping

A continued workflow creates a new `WorkflowEngine.execute()` call with carried-over state. The old execution completes with a `Suspended` result pointing to the new execution:

```typescript
import { Workflow } from "@effect/workflow"
import { Effect, Schema } from "effect"

// The continuation payload schema
const ContinuationState = Schema.Struct({
  cursor: Schema.String,
  lastResult: Schema.Unknown,
  iteration: Schema.Number,
})

// Workflow definition with continue-as-new support
const DaemonWorkflow = Workflow.make({
  name: "DaemonWorkflow",
  payload: ContinuationState,
  idempotencyKey: ({ cursor, iteration }) => `daemon-${iteration}`,
  success: Schema.Void,
  error: Schema.Never,
})

// Inside the workflow execution
const daemonExecution = Effect.gen(function*() {
  const state = yield* Workflow.payload

  for (let i = 0; i < continueAsNewEvery; i++) {
    yield* loopBody(state, i)
  }

  // Continue-as-new: complete this execution and start a new one
  // The workflow engine tracks the ancestry chain via execution IDs
  yield* Workflow.continueAsNew({
    cursor: updatedCursor,
    lastResult: latestResult,
    iteration: state.iteration + continueAsNewEvery,
  })
})
```

### Ancestry tracking via execution IDs

```typescript
// The workflow engine manages execution IDs internally
// Each continue-as-new produces:
// - Old execution: Result.Suspended (or Result.Complete with continuation metadata)
// - New execution: fresh WorkflowEngine.execute() with new executionId

// Query ancestry chain
const getAncestryChain = (executionId: string) =>
  Effect.gen(function*() {
    yield* Effect.annotateLogs({ executionId })
    yield* Effect.withLogSpan("engine:continue-as-new")(
      // Traverse execution IDs via workflow engine metadata
      // Each execution stores its parent execution ID
      queryExecutionLineage(executionId)
    )
  })
```

### Transactional handoff

```typescript
// The old run -> new run transition must be atomic
// Use Effect.acquireRelease for the DB claim
const continueAsNewHandoff = Effect.gen(function*() {
  yield* Effect.annotateLogs({ runId: oldRunId, newRunId })
  yield* Effect.withLogSpan("engine:continue-as-new")(
    Effect.gen(function*() {
      // WorkflowEngine handles this atomically:
      // 1. Mark old execution as completed/suspended
      // 2. Create new execution with carried-over state
      // 3. Link ancestry
      yield* Effect.logInfo(
        `Continuing run ${oldRunId} as ${newRunId} at iteration ${iteration}`
      )
    })
  )
})
```

### Effect patterns to apply

- Use `Workflow.make()` with an `idempotencyKey` that includes the iteration/generation number so each continuation is uniquely addressable
- The old execution completes with a `Suspended` or continuation-specific result; the new execution starts fresh with the carried-over payload
- Ancestry chain traversal is an Effect pipeline querying the workflow engine's execution metadata
- Cache seeding for the new run can use the workflow engine's state transfer mechanism

### Smithers Effect patterns to follow

- `src/effect/runtime.ts` — Use the custom runtime layer for workflow execution
- `src/effect/metrics.ts` — Wire continuation metrics (`smithers.runs.continued_total`, `smithers.runs.ancestry_depth`, `smithers.runs.carried_state_bytes`) using existing histogram/counter helpers
- `src/effect/logging.ts` — Annotate with `{ runId, newRunId, iteration, carriedStateBytes }`
- Follow the existing `Effect.gen` + `Effect.annotateLogs` + `Effect.withLogSpan` patterns used throughout the engine

### Reference files

- `/Users/williamcory/effect-reference/packages/workflow/src/Workflow.ts` — Workflow definition, continue-as-new semantics
- `/Users/williamcory/effect-reference/packages/workflow/src/WorkflowEngine.ts` — `WorkflowEngine.execute()`, execution lifecycle, `Workflow.Result` tagged union (`Complete | Suspended | Running`)
- `/Users/williamcory/effect-reference/packages/workflow/test/WorkflowEngine.test.ts` — Test patterns for workflow continuation and execution linking
