```ts
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
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

| Import           | Source                                                                                                       | Platform |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | -------- |
| `@smthrs/engine` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine/src/index.ts) | any      |

The service tag, `FlowInstance`, `annotateWaiting`, and `FlowCycleDetected`
live in [`@smthrs/flow`](/api/flow). What this package owns is the
implementation.

## The encoded seam

`Encoded` is the interface a store implements, and `makeUnsafe(encoded)` adapts
it into the typed `FlowRuntime` service. The seam is only partly encoded, and
the split is part of the contract:

| Member                                                                | Value crossing the seam                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `actionExecute`, `deferredResult`                                     | encoded; `makeUnsafe` decodes through the action or deferred exit schema |
| `deferredDone`, `deferredDoneIfWaiting`                               | encoded; `makeUnsafe` encodes before the call                            |
| `execute`, `poll`                                                     | decoded `Flow.Result` values, produced by the implementation             |
| `interrupt`, `interruptUnsafe`, `resume`, `scheduleClock`, `register` | no payload                                                               |

An implementation of `execute` or `poll` therefore decodes on its own, through
`Flow.Result({ success: flow.successSchema, error: flow.errorSchema })`, before
answering. Returning an encoded value from either one produces a silently wrong
system, because the seam types those returns as `Flow.Result<unknown, unknown>`.

`poll` answers `Option.none()` for a known execution that has not settled, and
also for an execution that belongs to a different flow declaration; only an
execution id no engine knows fails, with `FlowExecutionNotFound`. `interrupt`,
`interruptUnsafe`, and `resume` treat an unknown execution id as a silent
no-op: the request is idempotent, and a reaped run has nothing left to cancel.

## Execution identity

`executionId` is caller-supplied identity, not a server-minted handle. A
repeated id joins the run that already owns it and answers with that run's
recorded result, which is what makes a retried submission idempotent. Two
consequences follow.

A reused id under a different flow declaration is refused, because answering
would hand one flow's result to another flow's schemas. A reused id with a
different payload is refused for the same reason. Both refusals are coded
defects, listed under [Refusals](#refusals).

The derived transports pass `executionId` through from the request body by
default. Set the `executionId` option on
`FlowProxyServer.layerRpcHandlers` or `layerHttpApi` to rewrite it in one
server-owned place. Both layers apply the mapping to execute, discard, and
resume requests, so resume cannot bypass the namespace. Returning `undefined`
for execute or discard lets the engine derive the id from the flow's
idempotency key. Returning `undefined` for resume preserves the client value.

The hook is a pure function over the flow and request payload. Resume provides
an `undefined` payload because its request carries only an execution id. The
hook cannot read request-scoped authentication by itself. Middleware can put a
trusted tenant in the payload, or the server can wrap the layer with a mapping
that closes over the trusted namespace.

## Trampoline and journal identity

Two different ids in this package are called a lineage.

`Lineage` mints the JOURNAL lineage: a versioned encoded tuple of the run id
and the node path from the run root, carried as `meta.lineageId` on every
durable record. `Round` carries the TRAMPOLINE lineage: round zero's execution
id, naming the chain of round executions that one `Flow.execute` call follows
across handoffs. `Round.executionId` derives each later round's id from
`(lineageId, ordinal)` through the injected SHA-256, which is what makes a
handoff at-most-once across a restart. Those derived ids are persisted as run
rows, so their preimage is frozen by golden vectors in the package test suite
and changing it is a durable-identity break.

## In-memory lifetime

`FlowEngine.layerMemory` is a deterministic test and local-development runtime,
not a bounded store. It retains completed executions, action settlements,
deferred results, and clocks until the layer scope closes; there is no eviction
option. It rebuilds a submitted payload through the flow's own payload schema
constructor at admission and again on every re-drive, so neither the caller nor
a handler can mutate the value a later drive runs on. The constructor is the
copier because it is the only description of the payload the engine has: it
rebuilds each struct, array, and record the schema declares and hands back
declared-opaque values by reference. Same-key in-flight actions share one
settlement, so a concurrent duplicate dispatch waits rather than executing
twice.

## Flow proxies

`FlowProxy.toRpcGroup` and `toHttpApiGroup` derive Effect RPC or HTTP
definitions from a non-empty flow list, giving every flow execute, discard, and
resume operations. `operationAddresses` is the single source of those three
wire names, and every group builder and server layer derives from it.
`assertNoCollisions` runs first and refuses a flow set whose generated names are
ambiguous, such as a `Foo` beside a `FooDiscard`. HTTP routes encode a flow tag
as one opaque URL-safe segment, preserving case, reserved characters, and
Unicode normalization.

`FlowProxyServer.layerRpcHandlers` and `layerHttpApi` bind those definitions to
the running engine. Both drive the served bodies, so both require what those
bodies require: `Flow.Requirements` of every flow, on top of the schema services
`Flow.RequirementsHandler` names. A forgotten `Action.toLayer` is a compile
error on this side of the boundary too. The client side is unaffected: it
encodes a payload and decodes a result, and requires no implementation at all.
Both layers log a defect from a served body through `Effect.logError`, annotated
with the module and the wire operation name.

These modules expose flow transport only. They do not ship a server, a router,
an authentication policy, or a durable engine.

## Refusals

The engine's admission and configuration refusals are coded defects, so a
control plane or a proxy classifies one without scraping prose.

| Code                          | Raised when                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `flow_not_registered`         | a flow executes, or a handoff names a target, that no registration covers                 |
| `execution_identity_conflict` | a reused execution id names another flow declaration, or arrives with a different payload |
| `suspended_resume_gave_up`    | a caller polling a suspended lineage exhausts or outlives its `suspendedRetryPolicy`      |
| `snapshot_boundary_required`  | a compensable action runs with no `SnapshotBoundary` in context                           |
| `invalid_round`               | a trampoline identity or round budget is malformed                                        |
| `flow_proxy_collision`        | two derived operations share one wire name                                                |
| `invalid_flow_tag`            | a flow tag is not well-formed UTF-16, so it has no route encoding                         |

See [Getting started](/guides/getting-started), [Writing a flow](/guides/writing-a-flow), and [Determinism and replay](/concepts/determinism-and-replay).
