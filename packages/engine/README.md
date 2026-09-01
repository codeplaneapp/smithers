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
| `FlowEngine/`        | Interprets flows, executes actions, stores outcomes, and resumes suspended executions. `Encoded.ts` is the low-level seam, `make.ts` adapts it to the typed port, `layerMemory.ts` is the in-memory implementation, `FlowInstance.ts` builds per-execution state, and `SnapshotBoundary.ts` is the compensable host hook. |
| `FlowProxy.ts`       | Derives HTTP and RPC definitions for remotely invoking flows.                                                                                                                                                                                                                                                             |
| `FlowProxyServer.ts` | Connects those definitions to the actual flows and engine.                                                                                                                                                                                                                                                                |
| `index.ts`           | Exposes the public namespaces.                                                                                                                                                                                                                                                                                            |

## Public API

The root exports these namespaces, also available from matching
`@smthrs/engine/*` subpaths. The flow-authoring namespaces live in
[`@smthrs/flow`](https://www.npmjs.com/package/@smthrs/flow).

| Namespace         | Public exports                                                                                                                                                                                                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FlowEngine`      | Implementation boundary `Encoded` and `ActionExecuteOptions`; `makeUnsafe`, which adapts an `Encoded` implementation into `@smthrs/flow`'s `FlowRuntime`; in-memory `layerMemory`; per-run state constructor `makeInstance`; journal `Lineage`; trampoline `Round`; compensable-step `SnapshotBoundaryOptions` and `SnapshotBoundary`. |
| `FlowProxy`       | `toRpcGroup` / `ConvertRpcs` and `toHttpApiGroup` / `ConvertHttpApi` derive execute, discard, and resume transports from flows.                                                                                                                                                                                                        |
| `FlowProxyServer` | `layerRpcHandlers`, `layerHttpApi`, and `RpcHandlers` implement the derived transports.                                                                                                                                                                                                                                                |

## Reference implementation

The walkthrough below exercises the entire public API, namespace by
namespace.

### FlowEngine — the engine contract

```ts
import { FlowEngine } from "@smthrs/engine"
import { FlowRuntime } from "@smthrs/flow"
import { Effect } from "effect"

// FlowEngine is the service the flow/action/deferred/clock/queue APIs
// talk to. layerMemory is the in-memory implementation;
// @smthrs/engine-store provides the durable one. makeUnsafe builds a
// FlowEngine from an Encoded implementation (the persistence boundary).
const program = Effect.gen(function*() {
  const engine = yield* FlowRuntime.FlowRuntime
  // register, execute, poll, interrupt, interruptUnsafe, resume,
  // actionExecute (ActionExecuteOptions), deferredResult,
  // deferredDone, scheduleClock
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

Proxy construction refuses duplicate generated operation names before a group
or handler map exists. HTTP routes encode a flow tag as one opaque URL-safe
segment, preserving case, reserved characters, Unicode normalization, and
operation identity.

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
is no eviction option. It snapshots a flow payload through that flow's JSON
codec at admission and decodes a fresh value on every re-drive, so caller or
handler mutation cannot rewrite replay state. Same-key in-flight actions share
one settlement.
