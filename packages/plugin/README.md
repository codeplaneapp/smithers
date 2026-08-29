# @smthrs/plugin

Typed, Effect-native plugin kernel for the assembled cell loop. It owns
Vite-style plugin resolution and ordering, config resolution, the generic
dispatch service, and the startup kernel used by `@smthrs/agent`.
Durable-engine policies remain Effect services and constructor options rather
than plugin hooks.

```sh
npm install @smthrs/plugin
```

## Public API

`FlowsHooks` and the Hooks, Plugin, and PluginError members are flat root
exports. The remaining modules are namespaced; every source module is also
available from its matching `@smthrs/plugin/*` subpath.

| Export               | Public exports                                                                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FlowsHooks`         | Augmentable interface defining the shared `config` and `configResolved` lifecycle. A host adds only hooks it dispatches through `declare module "@smthrs/plugin"`; the cell host adds `cellRegistry`, `cellFlows`, and `cellModelRequest`.                                                  |
| Hooks (flat)         | Dispatch types `HookKind`, `HookMeta`, `HookObject`, `HookEntry`, `SequentialHook`, `ParallelHook`, `FirstHook`, and `WaterfallHook`; utilities `KindOf`, `HandlerOf`, `KeysOfKind`, `ArgsOf`, `ReturnOf`, `SuccessOf`, and `ContextOf`; runtime `engineHooks`, `handlerOf`, and `orderOf`. |
| Plugin (flat)        | `Apply`, `FlowsPlugin`, `PluginInput`, and identity constructor `make`.                                                                                                                                                                                                                     |
| Plugin errors (flat) | `PluginErrorCode` schema/type and `PluginError`.                                                                                                                                                                                                                                            |
| `Config`             | Schema/type pairs `RetryConfig`, `EngineConfig`, `FlowsConfig`, and `ResolvedConfig`; `defaults`, `merge`, `resolve`, and `deepFreeze`.                                                                                                                                                     |
| `Kernel`             | `Kernel` result model, `runConfig`, and `make(plugins, config, options)` resolve config and merge plugin layers. `options.cacheEnvironment` supplies complete capability and additional semantic layer/configuration identity for cross-run sealed reuse.                                   |
| `Plugins`            | `Service` / `Plugins` dispatch `sequential`, `parallel`, `first`, and `waterfall` hooks; `make`, `makeNoop`, `layer`, and `layerNoop`.                                                                                                                                                      |
| `Resolve`            | `HandlerRecord`, `Resolved`, and `Options`; `resolve` flattens, filters, validates, orders, and freezes plugins; `layer` merges resolved plugin layers.                                                                                                                                     |

```ts
import { type FlowsPlugin, Kernel } from "@smthrs/plugin"
import { Effect } from "effect"

const tuning: FlowsPlugin = {
  name: "flows-plugin-tuning",
  hooks: {
    config: () => Effect.succeed({ engine: { maxConcurrency: 8 } }),
    configResolved: (config) => Effect.log(`cell concurrency: ${config.engine.maxConcurrency}`)
  }
}

const program = Effect.gen(function*() {
  const kernel = yield* Kernel.make([tuning], {})
  return kernel.config
})
```

The production cell hooks and convenience constructor for contributing
executable flows are documented by
[`@smthrs/agent`](../agent/README.md).
