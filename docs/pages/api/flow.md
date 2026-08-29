---
description: "The flow authoring model: flow and action definitions, durable primitives, retry policy, and the runtime port."
---

# @smthrs/flow

The flow authoring model: typed flow and action definitions, durable primitives, step identity, retry policy, and the runtime port they execute against. The whole package bundles for the browser; durability comes from whichever runtime you provide.

An `Action` carries an implementation, attached separately as a layer. A `Flow` carries a required pure `body`, and `Interpreter.layer` drives it.

```ts
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { FlowEngine } from "@smthrs/engine"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const Compile = Action.make("example/Compile", {
  payload: { target: Schema.String },
  success: Schema.String,
  tier: "sealed"
})

const Build = Flow.make("example/Build", {
  payload: { target: Schema.String },
  success: Schema.String,
  body: (payload) => Compile.call(payload)
})

const layer = Layer.mergeAll(
  Compile.toLayer(({ target }) => Effect.succeed(`${target}.js`)),
  Interpreter.layer(Build)
).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(FlowEngine.layerMemory))
```

## Entry point

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/flow` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/flow/src/index.ts) | any |

## Flow

[src/Flow](https://github.com/smithersai/flows/tree/main/packages/flow/src/Flow)

| Export | Kind | Notes |
| --- | --- | --- |
| `make` | constructor | `Flow.make(tag, { payload, body, success, error?, idempotencyKey? })`; `body` is required |
| `Flow` | interface | carries `body`, `call`, `child`, `to`, `execute`, `executionId`, `poll`, `interrupt`, `resume` |
| `Execution` | interface | one invocation identified by `executionId` |
| `Any`, `AnyWithProps`, `AnyStructSchema` | interfaces | variance helpers |
| `PayloadSchema`, `RequirementsClient`, `RequirementsHandler` | types | derived schema and requirement types |
| `Complete`, `Suspended` | classes | the two result shapes |
| `CompleteSchema`, `CompleteEncoded` | interfaces | encoded completion |
| `Result`, `ResultEncoded` | type + schema | the result union and its codec |
| `isResult` | guard | |
| `intoResult` | combinator | turns a suspension interrupt into `Suspended` |
| `wrapActionResult` | combinator | encodes an action exit for storage |
| `suspend` | effect | suspends the current flow |
| `scope`, `provideScope`, `addFinalizer` | scope helpers | flow-scoped finalizers |
| `withRollback` | combinator | undoes a successful effect if the enclosing flow later fails |
| `CaptureDefects`, `SuspendOnFailure` | references | engine policy switches |
| `ExecutionIdRequired` | class | fails when no identity source can name the invocation |
| `ExecutionIdSource`, `CurrentExecutionIds`, `derived`, `layerExecutionIds` | interface + reference + source + layer | the ambient execution-id source, consulted when a call names no `executionId` and the flow declares no `idempotencyKey` |

## Action

[src/Action/](https://github.com/smithersai/flows/tree/main/packages/flow/src/Action)

| Export | Kind | Notes |
| --- | --- | --- |
| `make` | constructor | `name`, `success`, `error?`, `tier`, `idempotencyKey?`, `execute`, `metadata?`, `interruptRetryPolicy?` |
| `Action`, `Any`, `AnyWithProps` | interfaces | |
| `Tier` | type | `sealed`, `compensable`, `irreversible` |
| `IdempotencyKey` | schema + type | a string, or a caller-owned JSON object |
| `idempotencyKey` | function | resolves the declared key for a payload |
| `retry` | combinator | increments `CurrentAttempt` and delegates scheduling to Effect |
| `raceAll` | combinator | races actions, persisting one winner |
| `CurrentAttempt` | reference | the one-based durable attempt |
| `CurrentOrdinal`, `OrdinalSlot` | reference + interface | the per-scope ordinal used for invocation keys |
| `CacheEnvironment`, `CurrentCacheEnvironment`, `layerCacheEnvironment` | interface + reference + layer | declared layers and capability identity folded into cache keys |
| `InfraInterrupt` | class | infrastructure interruption, retried only under `interruptRetryPolicy` |
| `IrreversibleRetryRequiresIdempotencyKey` | class | irreversible retry without a key |
| `ConcurrentKeylessDispatch` | class | two live dispatches of one keyless action |
| `UncanonicalIdempotencyKey` | class | a key that canonical serialization rejects |

## Durable primitives

| Export | Source | Notes |
| --- | --- | --- |
| `DurableDeferred.make`, `into`, `raceAll`, `done`, `succeed`, `fail`, `failCause` | [src/DurableDeferred.ts](https://github.com/smithersai/flows/blob/main/packages/flow/src/DurableDeferred.ts) | await suspends the flow until a first exit is stored |
| `DurableDeferred.Token`, `TokenParsed`, `TokenTypeId`, `token`, `tokenFromExecutionId`, `tokenFromPayload` | same | addressable completion tokens |
| `DurableDeferred.DurableDeferred`, `Any`, `AnyWithProps` | same | |
| `DurableClock.make`, `sleep`, `DurableClock` | [src/DurableClock.ts](https://github.com/smithersai/flows/blob/main/packages/flow/src/DurableClock.ts) | absolute deadlines that re-arm on restart |
| `DurableQueue.make`, `process`, `worker`, `makeWorker`, `DurableQueue`, `TypeId` | [src/DurableQueue.ts](https://github.com/smithersai/flows/blob/main/packages/flow/src/DurableQueue.ts) | persisted queue plus a concurrency-limited worker layer |

## RetryPolicy

[src/RetryPolicy.ts](https://github.com/smithersai/flows/blob/main/packages/flow/src/RetryPolicy.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `RetryPolicy` | schema + type | data-shaped policy with `expirationMs` |
| `make`, `defaultRetryPolicy` | constructors | |
| `nextDelay`, `nextDelayEffect` | functions | pure and effectful backoff |
| `decide`, `decideEffect` | functions | the decision point, driven by the persisted attempt count |
| `RetryDecision`, `RetryAfter`, `GiveUp` | type + interfaces | |
| `retryAfter`, `giveUp` | constructors | |
| `errorTag`, `isNonRetryable`, `defaultNonRetryable` | helpers | error classification |
| `RetryPolicyExpired`, `RetryAttemptsExhausted` | classes | terminal retry failures |

## StepIdentity

[src/Action/StepIdentity.ts](https://github.com/smithersai/flows/blob/main/packages/flow/src/Action/StepIdentity.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `AllocationIdentity` | interface | action name refined by a declared string key |
| `allocationScope` | function | the scope an ordinal is allocated from |
| `invocationKey` | function | builds the run-local ordinal step key |

## FlowRuntime

[src/FlowRuntime](https://github.com/smithersai/flows/tree/main/packages/flow/src/FlowRuntime)

The execution contract the authoring APIs are written against. This package declares it and depends on nothing that implements it, so the dependency runs `@smthrs/flow` ← `@smthrs/engine` only.

| Export | Kind | Notes |
| --- | --- | --- |
| `FlowRuntime` | service | Register, execute, poll, interrupt, resume, execute actions, read and complete deferreds, schedule clocks |
| `FlowInstance` | service | One execution's mutable frontier state: execution id, flow, scope, suspension/interruption flags, waiting annotation, action coordination |
| `annotateWaiting` | combinator | Declares how the flow is about to wait, so a durable driver parks the run under that reason and token |
| `WaitingAnnotation` | model | `{ reason, wakeAt?, token? }` |
| `FlowCycleDetected` | error | Executing a flow would close a cycle in the persisted parent chain; part of the `execute` contract |
