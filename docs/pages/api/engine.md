---
description: "The runtime that executes flows: the encoded seam, the in-memory engine, and the RPC and HTTP facades."
---

# @smthrs/engine

The runtime that executes flows: the low-level encoded engine contract, its typed adapter onto `@smthrs/flow`'s `FlowRuntime` port, execution-instance state, the in-memory implementation, and the generated RPC/HTTP flow façades.

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

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/engine` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/engine/src/index.ts) | any |

## FlowEngine

[src/FlowEngine](https://github.com/smithersai/smithers/tree/main/packages/engine/src/FlowEngine)

The engine implements `FlowRuntime`, the port `@smthrs/flow` declares. The service tag, `FlowInstance`, `annotateWaiting`, and `FlowCycleDetected` live there; what this namespace owns is the implementation.

| Export | Kind | Notes |
| --- | --- | --- |
| `Encoded` | interface | the storage-facing seam, including `actionExecute` |
| `ActionExecuteOptions` | interface | action, attempt, step key, tier |
| `SnapshotBoundary`, `SnapshotBoundaryOptions` | class + interface | compensable snapshot hooks |
| `makeInstance` | constructor | the initial per-execution state a runtime hands to a flow run |
| `makeUnsafe` | constructor | adapts an `Encoded` implementation into the typed `FlowRuntime` |
| `layerMemory` | layer | in-process engine with no durability |

## Flow proxies

| Export | Source | Notes |
| --- | --- | --- |
| `FlowProxy.toRpcGroup`, `toHttpApiGroup`, `ConvertRpcs`, `ConvertHttpApi` | [src/FlowProxy.ts](https://github.com/smithersai/smithers/blob/main/packages/engine/src/FlowProxy.ts) | derives a client surface from flow definitions |
| `FlowProxyServer.layerRpcHandlers`, `layerHttpApi`, `RpcHandlers` | [src/FlowProxyServer.ts](https://github.com/smithersai/smithers/blob/main/packages/engine/src/FlowProxyServer.ts) | serves those definitions |

## API reference

This page is the public API reference for the runtime that executes flows: the low-level encoded engine contract, its typed adapter onto `@smthrs/flow`'s `FlowRuntime` port, execution-instance state, the in-memory implementation, and the generated RPC/HTTP flow façades. The authoring model it runs is documented in [`@smthrs/flow`](/api/flow).

### `FlowEngine`

`Encoded` is the implementation interface a durable store provides; `makeUnsafe(encoded)` adapts it into the typed `FlowRuntime` service, adding schema decoding and encoding on the way through. `makeInstance(flow, executionId)` builds the per-execution state a run is driven with. `layerMemory` provides the local, volatile implementation used in examples and tests. `SnapshotBoundary` is the host snapshot contract used by compensable actions.

### Flow proxies

`FlowProxy.toRpcGroup` and `toHttpApiGroup` derive Effect RPC or HTTP definitions from a non-empty flow list. `FlowProxyServer.layerRpcHandlers` and `layerHttpApi` bind registered flow operations to those façades.

These modules expose flow transport only; they do not ship a server, router, authentication policy, or durable engine.

See [Getting started](/guides/getting-started), [Writing a flow](/guides/writing-a-flow), and [Determinism and replay](/concepts/determinism-and-replay).
