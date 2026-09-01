# @smthrs/engine

The runtime that executes `@smthrs/flow` flows, plus the transport
projections that expose them. It implements `FlowRuntime` — the port
`@smthrs/flow` declares — over a low-level encoded contract, and ships a
volatile in-memory implementation of it; `@smthrs/engine-store` supplies
durable persistence over the same seam.

```sh
pnpm add @smthrs/engine @smthrs/flow
```

## Mental model

A `Flow` is the durable program and `Action` values are its recorded
operations — both defined in `@smthrs/flow`. This package is what runs them.

```text
@smthrs/flow                    @smthrs/engine
  Flow, Action,   ── port ──▶   FlowEngine
  DurableDeferred,  FlowRuntime   records, suspends, resumes
  DurableClock,                        │
  DurableQueue,                        ▼
  RetryPolicy                    Encoded seam
                                 (in-memory here,
                                  durable in engine-store)
```

| Source               | Role                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FlowEngine/`        | Interprets flows, executes actions, stores outcomes, and resumes suspended executions. `Encoded.ts` is the low-level seam, `make.ts` adapts it to the typed port, `layerMemory.ts` is the in-memory implementation, `ActionKey.ts` derives step identity, `FlowInstance.ts` builds per-execution state, `Lineage.ts` and `Round.ts` mint journal and trampoline identity, `Errors.ts` holds the coded refusals, and `SnapshotBoundary.ts` is the compensable host hook. |
| `FlowProxy.ts`       | Derives HTTP and RPC definitions for remotely invoking flows.                                                                                                                                                                                                                                                             |
| `FlowProxyServer.ts` | Connects those definitions to the actual flows and engine.                                                                                                                                                                                                                                                                |
| `index.ts`           | Exposes the public namespaces.                                                                                                                                                                                                                                                                                            |

## Public API

The root exports these namespaces, also available from matching
`@smthrs/engine/*` subpaths. The flow-authoring namespaces live in
[`@smthrs/flow`](https://www.npmjs.com/package/@smthrs/flow).

| Namespace         | Public exports                                                                                                                                                                                                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FlowEngine`      | Implementation boundary `Encoded` and `ActionExecuteOptions`; `makeUnsafe`, which adapts an `Encoded` implementation into `@smthrs/flow`'s `FlowRuntime`; in-memory `layerMemory`; per-run state constructor `makeInstance`; journal `Lineage` (`root`, `make`, `JournalLineageId`); trampoline `Round` (`initial`, `next`, `executionId`, `Round`, `InvalidRound`); the coded refusals `FlowNotRegistered`, `ExecutionIdentityConflict`, `SuspendedResumeGaveUp`, and `SnapshotBoundaryRequired`; compensable-step `SnapshotBoundaryOptions` and `SnapshotBoundary`. |
| `FlowProxy`       | `toRpcGroup` / `ConvertRpcs` and `toHttpApiGroup` / `ConvertHttpApi` derive execute, discard, and resume transports from flows. `operationAddresses` / `OperationAddresses` name the three wire operations one flow owns, `assertNoCollisions` refuses an ambiguous flow set with `FlowProxyCollision`, and `InvalidFlowTag` refuses a tag with no route encoding.                                                                                                                                                                                                        |
| `FlowProxyServer` | `layerRpcHandlers`, `layerHttpApi`, and `RpcHandlers` implement the derived transports.                                                                                                                                                                                                                                                |

## Reference implementation

The walkthrough below exercises the entire public API, namespace by
namespace.

### FlowEngine — the engine contract

```ts
import { FlowEngine } from "@smthrs/engine"
import { FlowRuntime } from "@smthrs/flow"
import { Effect } from "effect"

// FlowRuntime.FlowRuntime is the service the flow/action/deferred/clock/queue
// APIs talk to, and this package implements it. layerMemory is the in-memory
// implementation; @smthrs/engine-store provides the durable one. makeUnsafe
// builds one from an Encoded implementation (the persistence boundary).
const program = Effect.gen(function*() {
  const engine = yield* FlowRuntime.FlowRuntime
  // register, execute, poll, interrupt, interruptUnsafe, resume,
  // actionExecute (ActionExecuteOptions), deferredResult,
  // deferredDone, deferredDoneIfWaiting, scheduleClock
}).pipe(Effect.provide(FlowEngine.layerMemory))

// Per-execution state is created with FlowEngine.makeInstance. Compensable actions need a SnapshotBoundary
// (SnapshotBoundaryOptions) in context. Registering a flow that executes
// itself transitively fails with FlowCycleDetected.
```

### FlowProxy / FlowProxyServer — derived transports

```ts
import { FlowProxy, FlowProxyServer } from "@smthrs/engine"
import { Flow } from "@smthrs/flow"
import { Layer } from "effect"
import { HttpApi } from "effect/unstable/httpapi"
import { RpcServer } from "effect/unstable/rpc"

declare const Review: Flow.Any

// Each flow derives Execute / Discard / Resume endpoints
// (ConvertRpcs / ConvertHttpApi describe the derived types).
const ReviewRpcs = FlowProxy.toRpcGroup([Review], { prefix: "flows_" })
const ReviewApi = HttpApi.make("api").add(
  FlowProxy.toHttpApiGroup("flows", [Review])
)

// FlowProxyServer implements them against the running engine
// (RpcHandlers names the handler set).
const RpcLayer = RpcServer.layer(ReviewRpcs).pipe(
  Layer.provide(FlowProxyServer.layerRpcHandlers([Review], { prefix: "flows_" }))
)
const HttpLayer = FlowProxyServer.layerHttpApi(ReviewApi, "flows", [Review])
```

`FlowProxy.operationAddresses` is the single source of the three wire names one
flow owns, and every group builder and server layer derives from it.
`assertNoCollisions` runs first, so proxy construction refuses duplicate or
suffix-ambiguous operation names before a group or handler map exists. HTTP
routes encode a flow tag as one opaque URL-safe segment, preserving case,
reserved characters, Unicode normalization, and operation identity. Both server
layers log a defect from a served body through `Effect.logError`, annotated with
the module and the wire operation name.

Both server layers drive the served bodies, so both require what those bodies
require: `Flow.Requirements` of every flow, on top of the schema services
`Flow.RequirementsHandler` names. Serving a flow is executing it, and a
forgotten `Action.toLayer` is a compile error on this side of the boundary
too. The client side is unaffected — it encodes a payload and decodes a result,
and requires no implementation at all.

## In-memory lifetime

`FlowEngine.layerMemory` is a deterministic test and local-development
runtime, not a bounded store. It retains completed executions, action
settlements, deferred results, and clocks until the layer scope closes; there
is no eviction option. It rebuilds a submitted payload through the flow's own
payload schema constructor at admission and again on every re-drive, so caller
or handler mutation cannot rewrite replay state: structs, arrays, and records
the schema declares are copied, and values it declares opaque are shared by
reference. Same-key in-flight actions share one settlement.

`executionId` is caller-supplied identity. A repeated id joins the run that
already owns it and answers with that run's recorded result, so a retried
submission is idempotent; a reuse that names a different flow declaration, or
that arrives with a different payload, is refused with
`ExecutionIdentityConflict`. The derived transports pass the field through from
the request body, so a multi-tenant server namespaces or rejects the client
value before it reaches `Flow.execute`.
