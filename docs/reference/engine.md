# `@smthrs/engine`

This page is the public API reference for the runtime that executes flows: the low-level encoded engine contract, its typed adapter onto `@smthrs/flow`'s `FlowRuntime` port, execution-instance state, the in-memory implementation, and the generated RPC/HTTP flow façades. The authoring model it runs is documented in [`@smthrs/flow`](flow.md).

## `FlowEngine`

`Encoded` is the implementation interface a durable store provides; `makeUnsafe(encoded)` adapts it into the typed `FlowRuntime` service, adding schema decoding and encoding on the way through. `makeInstance(flow, executionId)` builds the per-execution state a run is driven with. `layerMemory` provides the local, volatile implementation used in examples and tests. `SnapshotBoundary` is the host snapshot contract used by compensable actions.

## Flow proxies

`FlowProxy.toRpcGroup` and `toHttpApiGroup` derive Effect RPC or HTTP definitions from a non-empty flow list. `FlowProxyServer.layerRpcHandlers` and `layerHttpApi` bind registered flow operations to those façades.

These modules expose flow transport only; they do not ship a server, router, authentication policy, or durable engine.

See [Getting started](../guides/getting-started.md), [Writing a flow](../guides/writing-a-flow.md), and [Determinism and replay](../concepts/determinism-and-replay.md).
