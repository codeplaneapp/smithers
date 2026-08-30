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
| `@smthrs/flow` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/flow/src/index.ts) | any |

## Flow

[src/Flow](https://github.com/smithersai/smithers/tree/main/packages/flow/src/Flow)

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

[src/Action/](https://github.com/smithersai/smithers/tree/main/packages/flow/src/Action)

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
| `DurableDeferred.make`, `into`, `raceAll`, `done`, `succeed`, `fail`, `failCause` | [src/DurableDeferred.ts](https://github.com/smithersai/smithers/blob/main/packages/flow/src/DurableDeferred.ts) | await suspends the flow until a first exit is stored |
| `DurableDeferred.Token`, `TokenParsed`, `TokenTypeId`, `token`, `tokenFromExecutionId`, `tokenFromPayload` | same | addressable completion tokens |
| `DurableDeferred.DurableDeferred`, `Any`, `AnyWithProps` | same | |
| `DurableClock.make`, `sleep`, `DurableClock` | [src/DurableClock.ts](https://github.com/smithersai/smithers/blob/main/packages/flow/src/DurableClock.ts) | absolute deadlines that re-arm on restart |
| `DurableQueue.make`, `process`, `worker`, `makeWorker`, `DurableQueue`, `TypeId` | [src/DurableQueue.ts](https://github.com/smithersai/smithers/blob/main/packages/flow/src/DurableQueue.ts) | persisted queue plus a concurrency-limited worker layer |

## RetryPolicy

[src/RetryPolicy.ts](https://github.com/smithersai/smithers/blob/main/packages/flow/src/RetryPolicy.ts)

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

[src/Action/StepIdentity.ts](https://github.com/smithersai/smithers/blob/main/packages/flow/src/Action/StepIdentity.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `AllocationIdentity` | interface | action name refined by a declared string key |
| `allocationScope` | function | the scope an ordinal is allocated from |
| `invocationKey` | function | builds the run-local ordinal step key |

## FlowRuntime

[src/FlowRuntime](https://github.com/smithersai/smithers/tree/main/packages/flow/src/FlowRuntime)

The execution contract the authoring APIs are written against. This package declares it and depends on nothing that implements it, so the dependency runs `@smthrs/flow` ← `@smthrs/engine` only.

| Export | Kind | Notes |
| --- | --- | --- |
| `FlowRuntime` | service | Register, execute, poll, interrupt, resume, execute actions, read and complete deferreds, schedule clocks |
| `FlowInstance` | service | One execution's mutable frontier state: execution id, flow, scope, suspension/interruption flags, waiting annotation, action coordination |
| `annotateWaiting` | combinator | Declares how the flow is about to wait, so a durable driver parks the run under that reason and token |
| `WaitingAnnotation` | model | `{ reason, wakeAt?, token? }` |
| `FlowCycleDetected` | error | Executing a flow would close a cycle in the persisted parent chain; part of the `execute` contract |

## API reference

This page is the public API reference for the flow authoring model: typed flows, recorded actions, durable deferreds/clocks/queues, retry policy, step identity, and the runtime port those APIs execute against. It contains no engine implementation: that is [`@smthrs/engine`](/api/engine).

### `Flow`

`Flow.make(tag, options)` accepts struct payload fields, success/error schemas, an optional `idempotencyKey`, annotations, and a suspended retry schedule. The returned definition exposes:

- `execute(payload, { executionId?, discard? })`
- `poll(executionId)`
- `interrupt(executionId)` and `resume(executionId)`
- `executionId(payload)`
- `toLayer(handler)`
- `annotate` and `annotateMerge`
- `withRollback`

`CurrentExecutionIds` is the ambient source consulted when a call names no `executionId` and the flow declares no `idempotencyKey`; `derived` is its default and `layerExecutionIds(source)` replaces it. `ExecutionIdRequired` is raised as a defect when no source can name the invocation. Result exports include `Complete`, `Suspended`, `Result`, encoded schemas, `intoResult`, and `wrapActionResult`. Scope helpers are `scope`, `provideScope`, `addFinalizer`, `withRollback`, and `suspend`. Policy references are `CaptureDefects` and `SuspendOnFailure`.

### `Action`

`Action.make(options)` defines a named effect with success/error schemas, `tier`, idempotency identity, metadata, annotations, and optional infrastructure-interrupt schedule.

| Export | Purpose |
| --- | --- |
| `Tier` | `sealed`, `compensable`, or `irreversible` |
| `InfraInterrupt` | Host-loss/rebalancing marker |
| `IrreversibleRetryRequiresIdempotencyKey` | Unsafe retry failure |
| `UncanonicalIdempotencyKey` | A caller-declared object-form `idempotencyKey` carried material canonical serialization rejects (`Date`, `undefined`, class instances, `Redacted`). Surfaces as a typed, non-retryable recorded completion naming the offending path: never as an untyped fiber defect (issue #151) |
| `retry(effect, options)` | Effect retry with durable attempt context |
| `CurrentCacheEnvironment` | The complete `{ layers, capabilities }` a sealed cache key is computed under. It is hashed separately from caller-owned identity. If absent, the engine scopes the key to the current execution |
| `CurrentAttempt`, `CurrentOrdinal` | Runtime references. `CurrentOrdinal` carries an `OrdinalSlot` (`{ values, cursors }`) rather than a number: the engine allocates each dispatch's ordinal under its declaration-identity scope and pins it per scope by dispatch position, so every attempt of one `Action.retry` sequence reuses its own action's ordinals even when the block dispatches several distinct actions or one declaration several times (issues #73, #84, #100). Nested blocks share the pinned `values` with the enclosing block (issue #108) but own a private `cursors` view seeded at block entry and merged back on exit, so a concurrent sibling block's attempt boundary never rewinds another block's mid-flight cursor (issue #116). Concurrent dispatch of one allocation scope is refused (`ConcurrentKeylessDispatch`) for every ordinal-keyed action, keyless, or keyed at a non-sealed tier, because arrival order would otherwise assign the ordinals; only a sealed action with an `idempotencyKey` (a pure cache key) may overlap on the same declared key, and distinct keys are distinct scopes that overlap freely (issues #111, #130) |
| `idempotencyKey(name, options?)` | Internal run-local invocation key |
| `raceAll(name, actions)` | Durable action race |

An action is itself an `Effect`; `action.execute` bypasses engine recording and should normally be used only by engine implementations.

Sealed idempotency identity has two forms. A string is namespaced by the action name and declared schemas. An object is caller-owned canonical JSON and remains stable across action renames. The engine separately adds the complete cache environment and any file boundary derived from `metadata`, so caller identity cannot override runtime facts.

### Durable primitives

| Namespace | Public surface |
| --- | --- |
| `DurableDeferred` | `make`, `await`, `into`, `raceAll`, branded token parsing/creation, and `done`/`succeed`/`fail`/`failCause` completion |
| `DurableClock` | `make({ name, duration })` and `sleep({ name, duration, inMemoryThreshold? })` |
| `DurableQueue` | `make`, `process`, `makeWorker`, and `worker` over Effect `PersistedQueue` |

Deferred tokens encode flow name, execution ID, and deferred name so another process can complete the correct durable address.

### `Poll`

`Poll.make(tag, options)` declares a durable poller and returns an ordinary flow. Its body is ONE attempt: run `check`, and either settle the lineage with the check's own output or sleep for this attempt's delay and hand off to the next round with the attempt counter raised. Each attempt is therefore a durable round with its own keyed plan nodes, a check that already ran replays from its recorded outcome, and the wait between attempts is a durable timer that survives a process restart.

| Option | Meaning |
| --- | --- |
| `input` | The author's payload fields. `attempt` is added to them and defaults to one |
| `result` | The schema the poll settles with |
| `check` | A body fragment returning `{ satisfied, output }`. It may not fail; state what a failure means with `Node.catch` inside the fragment |
| `intervalMs`, `backoff` | The wait before the next attempt: `fixed`, `linear` (interval × attempt), or `exponential` (interval × 2^(attempt−1)) |
| `maxAttempts` | The attempt bound. It is also the flow's `maxRounds`, so a lineage that opened another round is refused by the engine |
| `onTimeout` | `fail` fails `PollExhausted` at the bound; `return-last` answers with the last check output |

`delayMillis` is the exported schedule function, `CheckResult(result)` is the success schema a check action declares, `Failure` is the union a poll's rounds can fail with, and `Poll.layer` implements the `system/poll-exhausted` step.

`Poll.make` refuses a schedule no clock can keep, with a `RangeError` naming the option that is wrong: an `intervalMs` that is not finite or is negative becomes a `system/sleep` node whose timer never fires, and a `maxAttempts` below one whole attempt reaches `Flow.make` as a complaint about `maxRounds`, an option the author never wrote. The check is on the schedule rather than on the interval alone: `delayMillis` multiplies the interval by the backoff, so `{ intervalMs: 1000, maxAttempts: 2000, backoff: "exponential" }` states three finite options and still asks for a wait of `Infinity`. The last wait a poll can arm, the one before the final attempt, since the attempt at the budget gives up rather than sleeps, has to be a length too.

#### Bounding a check that can hang

A per-attempt time limit on the check is deliberately not a `Poll.make` option. A plan node's duration is not something the body around it can bound, so the bound goes in the check's own implementation, where `DurableDeferred.raceAll` races the work against a durable clock:

```ts
const Status = Action.make("deploy/status", {
  payload: { id: Schema.String, attempt: Schema.Number },
  success: Poll.CheckResult(Schema.String)
})

const statusLayer = Status.toLayer(({ attempt, id }) =>
  DurableDeferred.raceAll({
    name: `deploy/status#${attempt}`,
    success: Poll.CheckResult(Schema.String),
    error: Schema.Never,
    effects: [
      readDeployment(id),
      Effect.as(
        DurableClock.sleep({
          name: `deploy/status#${attempt}`,
          duration: Duration.seconds(30),
          inMemoryThreshold: Duration.zero
        }),
        { satisfied: false, output: "unknown" }
      )
    ]
  })
)
```

Three things make this the durable bound rather than a wall-clock one. The race records its winner under a name that carries the attempt, so a re-driven round reads the recorded outcome instead of racing again. The clock parks the execution rather than holding a fiber, so the bound outlives the process waiting on it. And the clock's branch answers `satisfied: false`, so a check that ran out of time costs the poll one attempt and nothing else: the round takes its declared interval and hands off to the next attempt exactly as an unsatisfied check does.

### `HumanTask`

`HumanTask.action` is the declared `system/human-task` step: a typed question with re-asking and a deadline, built on `WaitFor`'s wait points and `DurableClock`.

| Payload field | Meaning |
| --- | --- |
| `name` | Addresses the question. Two calls naming one question in one execution await one answer |
| `kind` | `ask` (prose), `confirm` (a boolean), `select` (one of `options`), `json` (a value `schema` accepts) |
| `prompt` | What the person is asked |
| `options` | The choices a `select` offers |
| `schema` | A JSON Schema in the bounded subset: `type` (`object`, `array`, `string`, `number`, `integer`, `boolean`, `null`), `enum`, `properties`, `required`, `items`, `nullable`, `description`, `title` |
| `maxAttempts` | How many answers may be refused before the task fails. Defaults to `defaultMaxAttempts` (10) |
| `timeoutMs` | How long the QUESTION stays open, across every attempt. A finite number of milliseconds that is not negative |

Each attempt is its own durable wait point, `WaitFor/<name>#<attempt>`, so an answer is recorded through the ordinary durable deferred path and a refused answer stays recorded under the attempt that refused it. The refusal itself is recorded as a sealed step named `HumanTask/<name>#<attempt>/rejected`, carrying the task, the attempt, and the reason, so a reader of the journal sees why an answer was sent back. The run parks under the `approval` waiting reason carrying the current attempt's token; `HumanTask.answer({ token, value })` records an answer against it. A re-driven round replays every answer it already has and parks on the first attempt that has none, so a restart between the park and the answer resumes on the same token.

`HumanTaskFailed` carries `code`, `task`, `attempts`, the `rejections` it collected, and a message. `request_invalid` refuses an unanswerable question before anyone is asked: a `select` with no options, an attempt budget below one, a `timeoutMs` that is not a length of time (`NaN` and a negative length are deadlines that have already passed, so the question would time out on its first park with nobody asked; `Infinity` is a deadline that never arrives), or a schema outside the subset. `rejected` means the budget was spent on answers the task refused. `timeout` means the deadline passed with the question open.

`timeoutMs` races the answer against one `DurableClock` per task through `DurableDeferred.raceAll`. The race parks and settles on whichever arrives first, on both hosts: `@smthrs/engine`'s in-process engine and the SQLite engine store each re-enter a parked race on the next drive, re-registering the raced deferreds against their persisted completions. A parked dispatch keeps its attempt row and its attempt number, so a question that waits out a person costs nothing against the action's retry budget.

`validate(value, request)` returns the reason an answer was refused, or `undefined`; run it in the interface so a typo is refused while the person is still looking at it. `validateSchema(schema)` checks that a schema stays inside the subset at every depth. `decode(schema)` gives the `Schema.Json` answer the caller's own type; the two schema descriptions must agree, and a disagreement surfaces as a defect rather than as a failure a body could catch.

### `FlowRuntime`

`FlowRuntime` is the service tag the authoring APIs are written against: registration, execution, polling, safe/unsafe interruption, resume, action execution, deferred lookup/completion, and clock scheduling. `FlowInstance` holds one execution's mutable frontier state, and `annotateWaiting` declares how the flow is about to wait so a durable driver can park it under that reason and token. `FlowCycleDetected` is the typed failure `execute` can return. `CancelRequestFailed` is the typed, recoverable failure returned by public interrupt surfaces when a durable runtime cannot transactionally record the run and its linked descendants; no ephemeral interruption occurs and durable cancellation state remains unchanged.

This package declares the port and depends on nothing that implements it, so the dependency direction is `@smthrs/flow` ← `@smthrs/engine` ← durable stores, with no cycle and no type-only escape hatch back.
