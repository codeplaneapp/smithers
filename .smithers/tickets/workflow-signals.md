# Signals — inject external data into running workflows

## Revision Summary

- Aligned the plan with the existing `WaitForEvent` primitive instead of introducing
  a second overlapping wait mechanism.
- Split rollout into two phases: durable external-event delivery first, ergonomic
  `<Signal>` wrapper second.
- Clarified that status handling should reuse `waiting-event` initially instead of
  adding `waiting-signal` everywhere.
- Removed the assumption that Sandbox MVP must depend on Signals.

## Problem

Smithers has approvals (binary approve/deny) and hijack (take over sessions), but no
general-purpose mechanism to inject arbitrary data into a running workflow from
outside. You can't say "the user uploaded a new file" or "the price changed to $42" or
"here are the review comments" and have the workflow react to it.

Temporal has three external interaction primitives: signals (async data injection),
queries (sync read-only), and updates (sync read-write). At minimum, Smithers needs
signals.

## Proposal

Add durable external data delivery for waiting workflows, and expose `<Signal>` as a
typed ergonomic wrapper over the same underlying machinery used by
`<WaitForEvent>`.

### Workflow code

```tsx
<Signal id="user-feedback" schema={z.object({ rating: z.number(), comment: z.string() })}>
  {(data) => (
    <Task id="process-feedback" input={data} output={outputs.result}>
      Process the user's feedback: {data.comment}
    </Task>
  )}
</Signal>
```

Or as a blocking wait:

```tsx
<Signal id="new-data" schema={dataSchema} />
{/* Subsequent nodes receive signal data via dependencies */}
```

### Sending a signal

**CLI:**
```
smithers signal <run-id> <signal-name> --data '{"rating": 5, "comment": "great"}'
```

**API:**
```
POST /signal/:runId/:signalName
Body: { "data": { "rating": 5, "comment": "great" } }
```

### Semantics

1. When scheduler encounters a Signal node with no data yet, the node transitions to
   `waiting-event`
2. Run status stays `waiting-event` unless there is a strong reason to add a more
   specific status later
3. Signal data is persisted to `_smithers_signals` table
4. Data is validated against the signal's Zod schema
5. Node transitions to runnable, downstream tasks receive signal data as dependency

### Schema

```sql
CREATE TABLE _smithers_signals (
  run_id TEXT NOT NULL,
  signal_name TEXT NOT NULL,
  iteration INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | received | cancelled
  schema_json TEXT,
  data_json TEXT,
  received_at_ms INTEGER,
  sender TEXT,
  PRIMARY KEY (run_id, signal_name, iteration)
);
```

### Why not just use approvals?

Approvals are boolean gates. Signals carry structured data that downstream tasks
consume. They're the building block for event-driven workflows, human-in-the-loop
data entry, webhook-triggered continuations, and Sandbox result delivery.

## Rollout phases

### Phase 1: Durable wait/delivery backend

- Land the persistent wait/resume machinery for external data delivery
- Make `WaitForEvent` actually resumable via CLI/API delivery

### Phase 2: `<Signal>` wrapper and CLI ergonomics

- Add `<Signal>` as a typed wrapper or specialization over the same backend
- Add `smithers signal ...` and matching HTTP API

## Additional Steps

1. Decide whether `_smithers_signals` is signal-specific or whether the delivery
   table should be generalized for both `WaitForEvent` and `Signal`.
2. Implement buffering so deliveries sent before the node is reached are stored and
   consumed later.
3. Validate payloads against the declared schema before unblocking the node.
4. Keep run status/reporting on `waiting-event` initially and add a friendlier label
   in CLI/UI if needed.
5. Add a shared unblock/resume path used by both `WaitForEvent` and `Signal`.
6. Keep Sandbox integration optional; it can adopt signals later after the delivery
   backend is stable.

## Verification requirements

### E2E tests

1. **Signal blocks, receives data, unblocks** — Workflow has `<Signal id="data" />`,
   run enters `waiting-event`. Send signal via CLI
   `smithers signal <id> data --data '{"x":1}'`. Assert run resumes, downstream task
   receives `{ x: 1 }`.

2. **Signal via API** — Same flow but via `POST /signal/:runId/data`. Assert 200
   response and run resumes.

3. **Schema validation** — Signal has `schema={z.object({ x: z.number() })}`. Send
   `{ x: "not a number" }`. Assert 400 error with Zod validation message. Run stays
   in `waiting-event`.

4. **Signal with children (render function)** — `<Signal id="fb" schema={s}>{(data) =>
   <Task ... />}</Signal>`. Assert child task receives signal data as its context.

5. **Multiple signals in one workflow** — Two `<Signal>` nodes in parallel. Send one
   signal. Assert only one branch unblocks. Send second. Assert run completes.

6. **Signal to non-existent run** — `smithers signal bad-id data --data '{}'`. Assert
   exit code 4, error message "Run not found".

7. **Signal to non-existent signal name** — Signal name doesn't match any `<Signal>`
   in the workflow. Assert error "Signal not found".

8. **Signal to already-received signal** — Send same signal twice. Second send should
   return error "Signal already received" (idempotency).

9. **Signal inside a Loop** — `<Loop><Signal id="step-data" /><Task .../></Loop>`.
   Each iteration waits for a new signal. Assert iteration 0 receives signal 0,
   iteration 1 receives signal 1.

10. **`smithers why` integration** — Run is waiting on a signal. Assert `why` reports
    "waiting for signal 'data-feed' — send with: smithers signal <id> data-feed --data ...".

11. **`smithers ps` integration** — Waiting event/signal runs show in `ps` with
    appropriate status/detail.

### Corner cases

12. **Signal sent before workflow reaches Signal node** — Send signal to a run that
    hasn't yet reached the `<Signal>` node (it's still executing prior tasks). Signal
    should be buffered and delivered when the node is reached.

13. **Empty data** — `smithers signal <id> data --data '{}'`. Should be valid if schema
    allows empty object.

14. **Large payload** — Signal with 1MB JSON body. Should work. Above 5MB, reject.

15. **Signal after run completes** — Send signal to a finished run. Assert error
    "Run is not active".

16. **Concurrent signals** — Two clients send different signals to the same run
    simultaneously. Both should be received without corruption.

### Size limits

17. **Max signal data**: 5MB JSON payload.
18. **Max signal name length**: 256 characters.
19. **Max signals per run**: 10,000 (to prevent unbounded table growth).

## Observability

### New events
- `SignalWaiting { runId, nodeId, signalName, iteration, timestampMs }`
- `SignalReceived { runId, nodeId, signalName, iteration, sender, dataSizeBytes, timestampMs }`
- `SignalValidationFailed { runId, signalName, error, timestampMs }`

### New metrics
- `smithers.signals.waiting` (gauge) — currently pending signals
- `smithers.signals.received_total` (counter) — signals received
- `smithers.signals.validation_failed_total` (counter) — schema validation failures
- `smithers.signals.wait_duration_ms` (histogram, durationBuckets) — time from signal
  creation to receipt
- `smithers.signals.data_size_bytes` (histogram, sizeBuckets) — payload size

### Logging
- `Effect.withLogSpan("signal:wait")`, `Effect.withLogSpan("signal:receive")`
- Annotate with `{ runId, nodeId, signalName, sender }`

## Codebase context

### Smithers files
- `src/components/WaitForEvent.ts` — **Primary reference**: Signal should share the
  same wait/resume machinery as this component.
- `src/components/Approval.ts:1-102` — secondary reference for external resolution
  patterns and operator actions.
- `src/engine/index.ts:2031-2085` — `approve` CLI command; signal CLI command follows
  same pattern (find pending, resolve, emit event)
- `src/RunStatus.ts:1-7` — `"waiting-event"` already exists and can be reused for
  signals (no new status needed)
- `src/db/internal-schema.ts` — Add `_smithers_signals` table alongside
  `_smithers_approvals`
- `src/SmithersEvent.ts` — Add signal events to the union
- `src/server/index.ts` — Add `POST /signal/:runId/:signalName` route
- `src/engine/scheduler.ts` — Add signal-waiting detection to `scheduleTasks()`,
  analogous to how approval-waiting is detected

### Temporal reference
- `temporal-reference/tests/signal_workflow_test.go:42` — `TestSignalWorkflow`:
  tests signal to non-existent workflow (NotFound), signal delivery, event history
  assertion, payload validation
- `temporal-reference/tests/signal_workflow_test.go:234` —
  `TestSignalWorkflow_DuplicateRequest`: idempotency testing
- `temporal-reference/tests/signal_workflow_test.go:1208` —
  `TestSignalWithStartWorkflow`: signal to already-running workflow, asserts
  `resp.Started == false`
- `temporal-reference/tests/signal_workflow_test.go:1677` —
  `TestSignalWithStartWorkflow_StartDelay`: delivery timing edge cases

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

- **`@effect/workflow`** — `DurableDeferred` replaces the custom `_smithers_signals` table and delivery backend entirely
- **`effect`** core — `Effect.gen`, `Effect.annotateLogs`, `Effect.withLogSpan`, `Schema` for signal payload validation

### Key mapping

The `<Signal>` JSX component is a user-facing boundary (exempt from Effect), but it compiles down to `DurableDeferred` calls in the engine:

```typescript
import { DurableDeferred } from "@effect/workflow"
import { Schema } from "effect"

// <Signal id="user-feedback" schema={z.object({ rating: z.number(), comment: z.string() })} />
// compiles to:
const signalDeferred = DurableDeferred.make("user-feedback", {
  success: Schema.Struct({
    rating: Schema.Number,
    comment: Schema.String,
  })
})

// Get the token for external delivery
const token = yield* DurableDeferred.token(signalDeferred)
// Publish token so CLI/API callers can deliver data
yield* publishSignalToken({ runId, signalName: "user-feedback", token })

// Block until signal is received
const data = yield* DurableDeferred.await(signalDeferred)
// data is typed as { rating: number, comment: string }
```

**No custom `_smithers_signals` table is needed.** `@effect/workflow` handles deferred persistence internally. Signal delivery from the CLI or API calls `DurableDeferred.done()` with the token:

```typescript
// smithers signal <run-id> user-feedback --data '{"rating": 5, "comment": "great"}'
// resolves to:
const deliverSignal = (token: string, data: unknown) =>
  Effect.gen(function*() {
    yield* Effect.annotateLogs({ runId, signalName })
    yield* Effect.withLogSpan("signal:receive")(
      DurableDeferred.done(token, data)
    )
  })
```

### Effect patterns to apply

```typescript
import { DurableDeferred } from "@effect/workflow"
import { Effect, Schema } from "effect"

// Signal wait inside a workflow
const waitForSignal = Effect.gen(function*() {
  yield* Effect.annotateLogs({ runId, nodeId, signalName })
  yield* Effect.withLogSpan("signal:wait")(
    Effect.logInfo("Waiting for signal")
  )

  const deferred = DurableDeferred.make(signalName, {
    success: signalSchema
  })
  const token = yield* DurableDeferred.token(deferred)
  yield* registerToken({ runId, signalName, token })

  const result = yield* DurableDeferred.await(deferred)
  yield* Effect.withLogSpan("signal:receive")(
    Effect.logInfo("Signal received")
  )
  return result
})

// Signal delivery via CLI/API handler
const handleSignalDelivery = (
  token: string,
  payload: unknown
) => Effect.gen(function*() {
  // Schema validation happens automatically via DurableDeferred.done()
  yield* DurableDeferred.done(token, payload)
})
```

### Smithers Effect patterns to follow

- `src/effect/runtime.ts` — Use the custom runtime layer for all signal Effect execution
- `src/effect/metrics.ts` — Wire signal metrics (`smithers.signals.waiting`, `smithers.signals.received_total`, etc.) into `trackEvent()` switch
- `src/effect/logging.ts` — Annotate signal spans with `{ runId, nodeId, signalName, sender }`
- Follow the existing `fromPromise()` interop pattern for any bridge code between the current `WaitForEvent` implementation and DurableDeferred

### What this eliminates

- The `_smithers_signals` SQL table from the proposal — workflow engine deferred storage handles persistence
- The manual buffering logic for signals sent before the node is reached — DurableDeferred handles this natively
- Custom resume/unblock paths — `DurableDeferred.await()` blocks and resumes automatically

### Reference files

- `/Users/williamcory/effect-reference/packages/workflow/src/DurableDeferred.ts` — `DurableDeferred.make()`, `.token()`, `.await()`, `.done()` API definitions
- `/Users/williamcory/effect-reference/packages/workflow/src/Workflow.ts` — How workflows integrate with deferred signals
- `/Users/williamcory/effect-reference/packages/workflow/test/WorkflowEngine.test.ts` — Test patterns for durable deferred/signal workflows
