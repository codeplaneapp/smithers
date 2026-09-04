---
title: "Contribute services from a plugin"
description: "Attach an Effect layer to a plugin, understand the merge order and what happens when two plugins provide the same tag, and handle a layer that fails to build."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/plugin/docs/guides/contribute-services.md"
---

A hook lets a plugin answer a question the host asks. A `layer` lets a plugin
add a service the rest of the composition can ask for. Declare both on the same
record when a plugin needs both.

## Attach a layer

```ts
import { Kernel, make } from "@smthrs/plugin"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

class Clock extends Context.Service<Clock, { readonly now: () => number }>()("example/Clock") {}

const clock = make({
  name: "flows-plugin-clock",
  layer: Layer.succeed(Clock)({ now: () => Date.now() })
})

const program = Effect.gen(function*() {
  const kernel = yield* Kernel.make([clock])
  return yield* Clock.pipe(
    Effect.map((service) => service.now()),
    Effect.provide(kernel.layer)
  )
})
```

`kernel.layer` is every selected plugin's layer merged into one. A plugin with
no `layer` contributes nothing, and a plugin list with no layers at all produces
an empty layer that is still safe to provide.

The value must be an Effect `Layer`. Anything else fails resolution with
`invalid_plugin` at `$.layer`, before the layer is ever built.

## Merge order follows resolved plugin order

Layers merge left to right in the resolved plugin order, so a service an earlier
plugin provides is visible to a later plugin's layer. `enforce: "pre"` is
therefore how a plugin makes sure its service is available to the plugins that
need it. See [Control the order handlers run in](/guides/order-handlers/).

When two plugins provide the same service tag, the later resolved plugin wins.
There is no collision error: last one in resolved order is the value the
composition sees. If two plugins genuinely conflict, decide it with `enforce`,
or with [`apply`](/guides/select-plugins/) so only one of them is selected.

## Handle a layer that fails to build

A layer's failure is wrapped as `layer_failed`, attributed to the plugin, with
the original cause on `cause`:

```ts
const failing = make({
  name: "flows-plugin-remote",
  layer: Layer.effectDiscard(Effect.fail("no credentials"))
})

const build = Effect.gen(function*() {
  const kernel = yield* Kernel.make([failing])
  return yield* Effect.void.pipe(Effect.provide(kernel.layer))
})
// Fails with PluginError { code: "layer_failed", plugin: "flows-plugin-remote" }
```

The failure arrives when the layer is built, not when the kernel is made:
`Kernel.make` validates that the value is a layer and composes it, and building
is the caller's step. A composition that never provides `kernel.layer` never
sees the failure.

## Layers are not the place for engine policy

A plugin layer contributes services to the composition the host assembled. It is
not a way to reach into durable execution policy: retry, storage, concurrency,
cache, wait, journal, and ownership stay on the components that apply them, and
the kernel refuses configuration keys that would suggest otherwise. Contribute a
service; let the host decide what to do with it.
