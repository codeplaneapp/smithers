# @smthrs/flow

**Documentation:** https://flow.smithers.sh

The flow authoring model. It defines typed flows, actions, durable waits
and queues, retry policy, step identity, and the runtime port those APIs are
executed against. `@smthrs/engine` implements that port; `@smthrs/engine-store`
makes it durable.

```sh
pnpm add @smthrs/flow
```

## Mental model

A `Flow` is the durable program, `Action` values are its recorded
operations, and a `FlowRuntime` runs them. The remaining primitives let the
program wait without requiring the process to stay alive.

```text
Flow
 ├─ executes Action values
 ├─ waits on DurableDeferred values
 ├─ sleeps with DurableClock
 └─ delegates work through DurableQueue
             │
             ▼
        FlowRuntime  (the port)
   records, suspends, and resumes
             ▲
             │
   @smthrs/engine  (the implementation)
```

| Source               | Role                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `Flow/`              | Defines a complete durable program and its execute, poll, interrupt, resume, and rollback lifecycle.                      |
| `Action/`            | Defines an individual durable operation whose result a runtime records or replays, plus its step identity and boundaries. |
| `FlowRuntime/`       | The execution contract those APIs require, the per-execution state contract, and the cycle failure `execute` can return.  |
| `DurableDeferred.ts` | A persisted promise that a flow can await across process restarts.                                                        |
| `DurableClock.ts`    | A timer that eventually completes a `DurableDeferred`.                                                                    |
| `DurableQueue.ts`    | Sends work to a persisted worker and awaits its result through a `DurableDeferred`.                                       |
| `Graph.ts`           | Builds the plan-time graph a body describes, before any of it runs.                                                       |
| `Interpreter.ts`     | Drives that graph, and registers a flow with the runtime.                                                                 |
| `Sleep.ts`           | The system timer, declared as an ordinary action.                                                                         |
| `WaitFor.ts`         | The system wait point, declared as an ordinary action.                                                                    |
| `Poll.ts`            | The durable poller: attempts as rounds, waits as durable timers.                                                          |
| `HumanTask.ts`       | Asking a person something, with validation, re-asking, and a deadline.                                                    |
| `RetryPolicy.ts`     | Data describing when a runtime should retry a failed action.                                                              |
| `index.ts`           | Exposes the public namespaces.                                                                                            |

## Usage

An `Action` carries an implementation, attached separately as a layer. A
`Flow` carries a `body`, and never opaque code.

```ts
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Effect, Layer, Schema } from "effect"

const Render = Action.make("render", {
  payload: { name: Schema.String },
  success: Schema.String
})

const Greet = Flow.make("Greet", {
  payload: { name: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ name }) => name,
  body: (payload) => Render.call(payload)
})

const GreetLayer = Layer.mergeAll(
  Render.toLayer(({ name }) => Effect.succeed(`hello ${name}`)),
  Interpreter.layer(Greet)
).pipe(Layer.provideMerge(Action.layerImplementations))
```

Provide a runtime — `FlowEngine.layerMemory` from `@smthrs/engine` in tests, or
the durable engine from `@smthrs/engine-store` in production — and execute the
flow.

### Planning is requirement-free; executing is not

`Render.call(payload)` records a node and runs nothing, so building the plan a
body describes asks for no service. What it does do is put a requirement in the
node's type — one minted by `Action.make` and keyed by the action tag — and
`Flow.make` reads the union of those off the node its body returns:

```ts
Greet.execute({ name: "Ada" }, { executionId: "greet-ada" })
// Effect<string, never, FlowRuntime | Action.Requirement<"render">>
```

`Render.toLayer(...)` provides that requirement, so the composition above erases
it and the wrong composition does not compile. **Forgetting an implementation is
an error at the call site rather than a run that dies partway through.** Three
rules follow from where a plan actually goes:

- `.call()` propagates the channel: an inline callee's steps join the caller's
  plan, so its obligations are the caller's.
- `.child()` and `.to()` drop it. Each opens a new execution whose driver
  provides its own context, and dropping it at `.to()` is also what keeps a
  self-looping lineage's type finite.
- `.poll()`, `.interrupt()`, and `.resume()` do not collect it. The first two
  never drive a body, and a re-drive runs under the context the flow was
  REGISTERED with, not the resumer's.

`Sleep` and `WaitFor` are declared with `Action.makeSystem` and mint no
requirement: the engine implements them, so an author cannot be the one who
forgot them.

The name-keyed `Action.Implementations` table is unchanged and is still how a
run resolves an action, because a driver expanding a plan read back out of a
journal has no types left to consult. `toLayer` does both — provides the tag,
and files into the table when a composition wired one up.

## Dependency direction

`@smthrs/flow` depends on no package that executes flows. `FlowRuntime` is the
seam: authoring APIs are written against the port, and an engine supplies it.
There is deliberately no dependency, type-only or otherwise, from this package
back to `@smthrs/engine`.

## Public API

The root exports these namespaces, also available from matching
`@smthrs/flow/*` subpaths.

The full, generated export tables are on the
[API reference](https://smithers.sh/api/flow); the table below is the shape of
the surface.

| Namespace         | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Flow`            | `Flow` plus the erased and schema helper types `AnyStructSchema`, `Execution`, `Any`, `AnyWithProps`, `PayloadSchema`, `Requirements`, `RequirementsClient`, and `RequirementsHandler`; `make`, whose `body` is required; the result guard, schemas, and models `isResult`, `Result`, `ResultEncoded`, `CompleteEncoded`, `CompleteSchema`, `Complete` (including `Complete.Schema`), `Suspended`, and `Handoff`; the trampoline outcome vocabulary `Outcome`, `Done`, `To`, `Park`, `done`, `park`, and `isOutcome`; runtime helpers `intoResult`, `wrapActionResult`, `scope`, `provideScope`, `addFinalizer`, `withRollback`, and `suspend`; annotations `CaptureDefects`, `SuspendOnFailure`, and `Placement`; the failures `ExecutionIdRequired` and `MaxRoundsExceeded`; execution identity `ExecutionIdSource`, `CurrentExecutionIds`, `derived`, and `layerExecutionIds`. A flow value exposes `body`, `call`, `child`, `to`, `execute`, `poll`, `interrupt`, `resume`, `executionId`, the annotation methods, and `withRollback`. |
| `Action`          | `Action`, `Declared`, `Requirement`, `Any`, and `AnyWithProps`; durability `Tier` and `IdempotencyKey`; `make`, `makeSystem`, `retry`, `idempotencyKey`, and `raceAll`; declared-action resolution `Implementations`, `Implementation`, and `layerImplementations`; the references `CurrentAttempt`, `CurrentOrdinal`, `OrdinalSlot`, `CurrentInvocationKey`, `CurrentCacheEnvironment`, and `DispatchSite`; caching `CacheEnvironment`, `layerCacheEnvironment`, `CachePolicy`, and `withCache`; the file-boundary vocabulary `FileInput`, `FileBoundary`, `BoundaryMode`, `Filegroup`, `Glob`, and `TreeArtifact`; step identity `AllocationIdentity`, `allocationScope`, and `invocationKey`; the errors `InfraInterrupt`, `InfraInterruptRetriesExhausted`, `IrreversibleRetryRequiresIdempotencyKey`, `ConcurrentKeylessDispatch`, and `UncanonicalIdempotencyKey`.                                                                                                                                                                   |
| `DurableDeferred` | `DurableDeferred`, `Any`, and `AnyWithProps`; `make`, `await`, `into`, and `raceAll`; the token API `TokenTypeId`, `Token`, `TokenParsed` (`FromString`, `fromString`, `encode`, `asToken`), `token`, `tokenFromExecutionId`, and `tokenFromPayload`; external completion `done`, `succeed`, `fail`, and `failCause`, and the `TokenInvalid` failure they share.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `DurableClock`    | `DurableClock`, `make({ name, duration })`, and threshold-aware `sleep(options)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `DurableQueue`    | `TypeId`, `DurableQueue`, `make`, the flow-side `process`, the worker effect `makeWorker`, and the worker layer constructor `worker`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Graph`           | `build`, the accessors `nodes`, `edges`, `drafts`, and `diagnostics`, and the models `Graph`, `GraphNode`, `Edge`, `EdgeReason`, `LayerRequest`, and `BuildOptions`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `Interpreter`     | `layer`, `interpret`, `childExecutionId`, the `Interpretation` model, and the `InterpreterError` refusals.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `Sleep`           | `tag`, `action`, `layer`, and the `SleepRequestInvalid` failure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `WaitFor`         | `tag`, `action`, `deferred`, `layer`, and the `WaitForRequestInvalid` failure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `Poll`            | The durable poller: `make(tag, options)` returning a flow whose body is one attempt; `Backoff`, `Check`, `CheckResult`, `delayMillis`, `Failure`, `PayloadSchema`, `PollExhausted`, `exhausted`, `exhaustedTag`, and `layer`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `HumanTask`       | Asking a person something: `action` and `tag`; `Kind`, `Request`, `HumanTaskFailed`, and `defaultMaxAttempts`; `deferred(name, attempt)` and the `answer` resolver; `validate`, `validateSchema`, and the typed view `decode`; the documented size bounds; `layer`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `RetryPolicy`     | The `RetryPolicy` schema and type, `make`, `defaultRetryPolicy`, and `defaultNonRetryable`; the decisions `RetryAfter`, `GiveUp`, `RetryDecision`, `retryAfter`, and `giveUp`; `nextDelay`, `nextDelayEffect`, `errorTag`, `isNonRetryable`, `decide`, and `decideEffect`; the terminal failures `RetryPolicyExpired` and `RetryAttemptsExhausted`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `FlowRuntime`     | The execution contract this package declares: the `FlowRuntime` service, the per-execution `FlowInstance` service, `annotateWaiting` and `WaitingAnnotation`, and the failures `FlowCycleDetected`, `FlowExecutionNotFound`, and `CancelRequestFailed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `StepIdentity`    | `allocationScope`, `invocationKey`, and `AllocationIdentity`, the one canonical derivation of ordinal step identity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Source layout

### Flow source layout

- `Flow.ts` defines the data structure.
- `make.ts` constructs flows.
- `Runtime.ts` implements lifecycle operations.
- `Result.ts` defines persisted execution results, including `Handoff`.
- `Outcome.ts` defines the vocabulary a trampoline round settles with.
- `Annotations.ts` defines execution configuration.
- `ExecutionIds.ts` holds the ambient execution-id source and its default.
- `ExecutionIdRequired.ts` defines the missing-identity defect.
- `MaxRoundsExceeded.ts` defines the trampoline round-budget failure.
- `TypeId.ts` contains the private runtime marker.

### Top-level source layout

- `Graph.ts` builds the plan-time graph, and reports the topology it refuses.
- `Interpreter.ts` drives that graph and registers a flow with the runtime.
- `Sleep.ts` and `WaitFor.ts` declare the two system wait steps.
- `Poll.ts` builds a durable poller out of them.
- `HumanTask.ts` builds a typed question out of `WaitFor` and `DurableClock`.

### Action source layout

- `Action.ts` defines the data structure and schemas.
- `make.ts` constructs executable actions and mints each declaration's requirement.
- `Implementations.ts` holds the name-keyed table a driver resolves a persisted plan through.
- `Context.ts` carries attempt and cache state during execution.
- `retry.ts` retries operations while preserving durable identity.
- `StepIdentity.ts` and `idempotencyKey.ts` derive recorded execution keys.
- `FileInput.ts`, `FileBoundary.ts`, and `BoundaryMode.ts` describe filesystem access.
- `CacheEnvironment.ts` describes runtime facts included in cache identity, and carries the `CachePolicy` annotation (`ttlMs`, `scope`) the engine reads at dispatch; `withCache` declares it on an action.
- `raceAll.ts` durably races actions.
- `Errors.ts` defines typed failures.
- `TypeId.ts` contains the private runtime marker.

### Flow — define, handle, run, observe

```ts
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Effect, Layer, Option, Schema } from "effect"

class ReviewFailed extends Schema.TaggedError<ReviewFailed>()(
  "ReviewFailed",
  { reason: Schema.String }
) {}

// Action.make: the named atom, declared without code.
const Verdict = Action.make("review", {
  payload: { pr: Schema.String },
  success: Schema.String,
  error: ReviewFailed
})

// Flow.make: payload fields (or a struct schema), success/error schemas, the
// required pure body, and an optional idempotencyKey for deterministic
// execution IDs.
const Review = Flow.make("Review", {
  payload: { pr: Schema.String },
  success: Schema.String,
  error: ReviewFailed,
  idempotencyKey: ({ pr }) => pr,
  body: (payload) => Verdict.call(payload)
})

// Flow annotations: capture defects in results, or park instead of failing.
const Hardened = Review
  .annotate(Flow.CaptureDefects, true)
  .annotate(Flow.SuspendOnFailure, true)

// Interpreter.layer drives the body; the action implementations the body
// names attach beside it, over the table they file themselves in.
const ReviewHandler = Layer.mergeAll(
  Verdict.toLayer(({ pr }) => Effect.succeed(`lgtm ${pr}`)),
  Interpreter.layer(Review)
).pipe(Layer.provideMerge(Action.layerImplementations))

// Run and observe. Identity precedence is an explicit executionId, the
// flow's idempotencyKey (Review has one), then CurrentExecutionIds.derived.
// discard: true returns that execution ID without waiting.
const run = Effect.gen(function*() {
  const executionId = yield* Review.executionId({ pr: "42" })
  const started = yield* Review.execute({ pr: "42" }, { discard: true })
  const result = yield* Review.poll(executionId) // Option<Flow.Result<string, ReviewFailed>>
  if (Option.isSome(result) && Flow.isResult(result.value)) {
    // "Complete" (Flow.Complete) | "Suspended" (Flow.Suspended) |
    // "Handoff" (Flow.Handoff, the next round of a trampoline lineage)
    result.value._tag
  }
  yield* Review.interrupt(executionId)
  yield* Review.resume(executionId)
  return started
}).pipe(
  Effect.provide(ReviewHandler),
  Effect.provide(FlowEngine.layerMemory)
)
```

Inside a handler, `Flow.scope` / `Flow.provideScope` / `Flow.addFinalizer`
manage the execution-scoped resource scope, `Flow.suspend(instance)` parks
the execution, `Flow.withRollback(effect, rollback)` registers how to undo a
successful effect if the enclosing flow later fails, and `Flow.intoResult` /
`Flow.wrapActionResult` convert
handler effects to `Flow.Result` values (serialized via `Flow.Result`,
`Flow.ResultEncoded`, `Flow.Complete.Schema`, and `Flow.Suspended`).

Executing without an execution ID and without a declared `idempotencyKey`
normally succeeds: identity falls through to the ambient
`Flow.CurrentExecutionIds` source, whose default hashes the flow tag with the
payload's canonical form. `Flow.ExecutionIdRequired` is what that source DIES
with when the payload has no canonical form, for example a non-finite number, a
lone surrogate, or a cycle. It is a defect rather than a typed failure, because
a run started under a guessed identity is worse than a run that does not start.
`Flow.layerExecutionIds(source)` replaces the source when equal payloads of one
flow are not one piece of work in this host.

Registering a behavior under a flow tag is the runtime's own seam and stays
internal to this package: a flow has one behavior and it is the body, so there
is no `toLayer` on a flow to attach a second one with.

### Action — durable steps, tiers, retries, races

```ts
import { Action, RetryPolicy } from "@smthrs/flow"
import { Effect, Schema } from "effect"

// Tiers: "sealed" (default), "compensable" (requires a
// FlowEngine.SnapshotBoundary in context), "irreversible" (retry requires
// an idempotencyKey, else IrreversibleRetryRequiresIdempotencyKey).
const charge = Action.make({
  name: "charge",
  success: Schema.String,
  error: Schema.String,
  tier: "irreversible",
  idempotencyKey: "charge:pr-42", // string | object
  retryPolicy: RetryPolicy.defaultRetryPolicy,
  execute: Effect.gen(function*() {
    const attempt = yield* Action.CurrentAttempt // 1-based retry attempt
    // An OrdinalSlot ({ values, cursors }), not a number: the engine allocates
    // and pins each dispatch's ordinal under its declaration-identity scope.
    const ordinal = yield* Action.CurrentOrdinal
    // Action.idempotencyKey derives a run-local invocation key effectfully:
    const key = yield* Action.idempotencyKey("charge", { includeAttempt: true })
    return `charged on attempt ${attempt} (step ${ordinal}, key ${key})`
  })
})

// Action.retry wraps an action with Effect.retry semantics while
// threading CurrentAttempt/CurrentOrdinal; Action.raceAll races several
// actions durably. Infrastructure interrupts surface as
// Action.InfraInterrupt and honor `interruptRetryPolicy`.
const resilient = Action.retry(charge, { times: 3 })
const fastest = Action.raceAll("fastest-charge", [charge, resilient])
```

### Poll — keep asking until it is ready

```ts
import { Action, Poll } from "@smthrs/flow"
import { Schema } from "effect"

const Status = Action.make("deploy/status", {
  payload: { id: Schema.String, attempt: Schema.Number },
  success: Poll.CheckResult(Schema.String)
})

// One attempt is one durable round: the check runs, and either settles the
// lineage or sleeps for this attempt's delay and hands off to the next round.
const Deployment = Poll.make("deploy/wait", {
  input: { id: Schema.String },
  result: Schema.String,
  intervalMs: 5_000,
  backoff: "exponential", // "fixed" | "linear" | "exponential"
  maxAttempts: 8,
  onTimeout: "fail", // or "return-last" to answer with the last check output
  check: ({ attempt, id }) => Status.call({ attempt, id })
})

// A spent budget fails Poll.PollExhausted, which a body catches like any
// other declared failure. Provide Poll.layer beside Sleep.layer. A check that
// can hang bounds itself: race the work against a durable clock inside the
// check's own implementation (docs/pages/api/flow.md shows the recipe), so the
// bound is replayable and a check that ran out of time costs one attempt.
//
// A schedule no clock can keep is refused at declaration with a RangeError:
// an interval that is not a finite, non-negative length, a budget below one
// attempt, or a backoff that reaches an infinite wait before the budget is
// spent.
```

### HumanTask — ask a person, and re-ask

```ts
import { HumanTask } from "@smthrs/flow"
import { Schema } from "effect"

const Decision = Schema.Struct({ decision: Schema.Literals(["ship", "hold"]) })

const asked = HumanTask.action.call({
  name: "release",
  kind: "json", // "ask" | "confirm" | "select" | "json"
  prompt: "Ship the release?",
  schema: {
    type: "object",
    required: ["decision"],
    properties: { decision: { enum: ["ship", "hold"] } }
  },
  maxAttempts: 3,
  timeoutMs: 6 * 60 * 60 * 1000
}).pipe(HumanTask.decode(Decision))

// The run parks under `approval` carrying the current attempt's token.
// Whoever collects the answer records it against that token:
const recorded = HumanTask.answer({ token, value: { decision: "ship" } })

// An answer the schema refuses parks again on the next attempt's token, and
// the reason it was refused is recorded as a step of its own,
// `HumanTask/<name>#<attempt>/rejected`. A spent budget fails HumanTaskFailed
// `rejected`; a passed deadline fails it `timeout`. A question nobody could
// answer — no options to choose from, a budget below one attempt, a timeoutMs
// that is not a finite, non-negative length of time — fails it
// `request_invalid` before anyone is asked. Provide HumanTask.layer beside the
// other implementations.
//
// `timeoutMs` races the answer against one durable clock per question. Both
// hosts resume a run parked on that race, so a deadline settles under
// `@smthrs/engine`'s in-process engine and under the SQLite engine store
// alike (docs/pages/api/flow.md has the detail).
```

### DurableClock — durable sleep

```ts
import { DurableClock } from "@smthrs/flow"

// Short sleeps run in memory; anything past inMemoryThreshold (default
// 60s) schedules a durable clock and suspends the flow.
const wait = DurableClock.sleep({
  name: "cooldown",
  duration: "2 days",
  inMemoryThreshold: "30 seconds"
})

// DurableClock.make builds the clock value directly.
const clock = DurableClock.make({ name: "cooldown", duration: "2 days" })
```

### DurableDeferred — external completion

```ts
import { DurableDeferred } from "@smthrs/flow"
import { Effect, Exit, Schema } from "effect"

const Approval = DurableDeferred.make("Approval", {
  success: Schema.Boolean,
  error: Schema.String
})

// Inside the flow: await the deferred (suspends until completed), or run
// an effect "into" it so its exit completes the deferred durably.
const awaitApproval = DurableDeferred.await(Approval)
const computed = DurableDeferred.into(Effect.succeed(true), Approval)
// raceAll races effects durably, persisting the first exit:
const winner = DurableDeferred.raceAll({
  name: "first-answer",
  success: Schema.Boolean,
  error: Schema.String,
  effects: [awaitApproval, computed]
})

// Tokens identify a deferred from outside the flow. Inside a flow:
const tokenInFlow = DurableDeferred.token(Approval)
// Outside, derive it from the flow + executionId or payload:
declare const Review: import("@smthrs/flow").Flow.Any
const token = DurableDeferred.tokenFromExecutionId(Approval, {
  flow: Review,
  executionId: "run-17"
})
const tokenFromPayload = DurableDeferred.tokenFromPayload(Approval, {
  flow: Review,
  payload: { pr: "42" }
})
// Tokens round-trip through DurableDeferred.Token /
// DurableDeferred.TokenParsed (fromString / FromString / encode / asToken).

// External completion resumes the suspended flow:
const approve = DurableDeferred.succeed(Approval, { token, value: true })
const reject = DurableDeferred.fail(Approval, { token, error: "denied" })
const settle = DurableDeferred.done(Approval, { token, exit: Exit.succeed(true) })
// DurableDeferred.failCause completes with a full Cause.
```

### DurableQueue — durable work queues

```ts
import { DurableQueue } from "@smthrs/flow"
import { Effect, Schema } from "effect"

const Renders = DurableQueue.make({
  name: "Renders",
  payload: { page: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ page }) => page
})

// Flow side: enqueue and durably wait for a worker's answer.
const rendered = DurableQueue.process(Renders, { page: "home" })

// Worker side: DurableQueue.worker returns a Layer (forked, scoped);
// DurableQueue.makeWorker is the underlying worker effect.
const RendersWorker = DurableQueue.worker(
  Renders,
  ({ page }) => Effect.succeed(`<html>${page}</html>`),
  { concurrency: 4 }
)
```

### RetryPolicy — declarative retry decisions

```ts
import { RetryPolicy } from "@smthrs/flow"

const policy = RetryPolicy.make({
  initialMs: 100,
  factor: 2,
  maxMs: 10_000,
  maxAttempts: 5,
  jitterRatio: 0.2,
  nonRetryable: ["ReviewFailed"]
})
// RetryPolicy.defaultRetryPolicy: 200ms initial, 1.5x factor, 30s cap.

// Pure decision helpers:
const decision = RetryPolicy.decide(policy, { attempt: 2, error: new Error("x") })
// RetryDecision = RetryAfter | GiveUp; built with retryAfter(ms) / giveUp(reason)
const delay = RetryPolicy.nextDelay(policy, 2) // Option<number>; None = give up
RetryPolicy.errorTag(new Error("x")) // extract an error's tag
RetryPolicy.isNonRetryable(policy, new Error("x"))
// RetryPolicy.decideEffect is the effectful variant; exhausting attempts
// yields RetryPolicy.RetryAttemptsExhausted.
```

Full API documentation is at
[smithers.sh/api/flow](https://smithers.sh/api/flow). See also the
[engine reference](https://smithers.sh/api/engine),
[failure and retry](https://smithers.sh/concepts/failure-and-retry), and
[step keys](https://smithers.sh/concepts/step-keys).
