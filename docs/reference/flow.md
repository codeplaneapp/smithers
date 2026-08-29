# `@smthrs/flow`

This page is the public API reference for the flow authoring model: typed flows, recorded actions, durable deferreds/clocks/queues, retry policy, step identity, and the runtime port those APIs execute against. It contains no engine implementation — that is [`@smthrs/engine`](engine.md).

## `Flow`

`Flow.make(tag, options)` accepts struct payload fields, success/error schemas, an optional `idempotencyKey`, annotations, and a suspended retry schedule. The returned definition exposes:

- `execute(payload, { executionId?, discard? })`
- `poll(executionId)`
- `interrupt(executionId)` and `resume(executionId)`
- `executionId(payload)`
- `toLayer(handler)`
- `annotate` and `annotateMerge`
- `withRollback`

`CurrentExecutionIds` is the ambient source consulted when a call names no `executionId` and the flow declares no `idempotencyKey`; `derived` is its default and `layerExecutionIds(source)` replaces it. `ExecutionIdRequired` is raised as a defect when no source can name the invocation. Result exports include `Complete`, `Suspended`, `Result`, encoded schemas, `intoResult`, and `wrapActionResult`. Scope helpers are `scope`, `provideScope`, `addFinalizer`, `withRollback`, and `suspend`. Policy references are `CaptureDefects` and `SuspendOnFailure`.

## `Action`

`Action.make(options)` defines a named effect with success/error schemas, `tier`, idempotency identity, metadata, annotations, and optional infrastructure-interrupt schedule.

| Export | Purpose |
| --- | --- |
| `Tier` | `sealed`, `compensable`, or `irreversible` |
| `InfraInterrupt` | Host-loss/rebalancing marker |
| `IrreversibleRetryRequiresIdempotencyKey` | Unsafe retry failure |
| `UncanonicalIdempotencyKey` | A caller-declared object-form `idempotencyKey` carried material canonical serialization rejects (`Date`, `undefined`, class instances, `Redacted`). Surfaces as a typed, non-retryable recorded completion naming the offending path — never as an untyped fiber defect (issue #151) |
| `retry(effect, options)` | Effect retry with durable attempt context |
| `CurrentCacheEnvironment` | The complete `{ layers, capabilities }` a sealed cache key is computed under. It is hashed separately from caller-owned identity. If absent, the engine scopes the key to the current execution |
| `CurrentAttempt`, `CurrentOrdinal` | Runtime references. `CurrentOrdinal` carries an `OrdinalSlot` (`{ values, cursors }`) rather than a number: the engine allocates each dispatch's ordinal under its declaration-identity scope and pins it per scope by dispatch position, so every attempt of one `Action.retry` sequence reuses its own action's ordinals even when the block dispatches several distinct actions or one declaration several times (issues #73, #84, #100). Nested blocks share the pinned `values` with the enclosing block (issue #108) but own a private `cursors` view seeded at block entry and merged back on exit, so a concurrent sibling block's attempt boundary never rewinds another block's mid-flight cursor (issue #116). Concurrent dispatch of one allocation scope is refused (`ConcurrentKeylessDispatch`) for every ordinal-keyed action — keyless, or keyed at a non-sealed tier — because arrival order would otherwise assign the ordinals; only a sealed action with an `idempotencyKey` (a pure cache key) may overlap on the same declared key, and distinct keys are distinct scopes that overlap freely (issues #111, #130) |
| `idempotencyKey(name, options?)` | Internal run-local invocation key |
| `raceAll(name, actions)` | Durable action race |

An action is itself an `Effect`; `action.execute` bypasses engine recording and should normally be used only by engine implementations.

Sealed idempotency identity has two forms. A string is namespaced by the action name and declared schemas. An object is caller-owned canonical JSON and remains stable across action renames. The engine separately adds the complete cache environment and any file boundary derived from `metadata`, so caller identity cannot override runtime facts.

## Durable primitives

| Namespace | Public surface |
| --- | --- |
| `DurableDeferred` | `make`, `await`, `into`, `raceAll`, branded token parsing/creation, and `done`/`succeed`/`fail`/`failCause` completion |
| `DurableClock` | `make({ name, duration })` and `sleep({ name, duration, inMemoryThreshold? })` |
| `DurableQueue` | `make`, `process`, `makeWorker`, and `worker` over Effect `PersistedQueue` |

Deferred tokens encode flow name, execution ID, and deferred name so another process can complete the correct durable address.

## `FlowRuntime`

`FlowRuntime` is the service tag the authoring APIs are written against: registration, execution, polling, safe/unsafe interruption, resume, action execution, deferred lookup/completion, and clock scheduling. `FlowInstance` holds one execution's mutable frontier state, and `annotateWaiting` declares how the flow is about to wait so a durable driver can park it under that reason and token. `FlowCycleDetected` is the typed failure `execute` can return. `CancelRequestFailed` is the typed, recoverable failure returned by public interrupt surfaces when a durable runtime cannot transactionally record the run and its linked descendants; no ephemeral interruption occurs and durable cancellation state remains unchanged.

This package declares the port and depends on nothing that implements it, so the dependency direction is `@smthrs/flow` ← `@smthrs/engine` ← durable stores, with no cycle and no type-only escape hatch back.
