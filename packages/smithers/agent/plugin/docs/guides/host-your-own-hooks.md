---
title: "Declare hooks for your host"
description: "Add extension points of your own: augment FlowsHooks, supply the matching runtime catalog, resolve for your target, and dispatch only what you declared."
sidebar:
  order: 1
---

The kernel dispatches two hooks of its own. Every other extension point is
yours to declare. Adding one takes three pieces that must agree: a type
declaration, a runtime catalog entry, and a dispatch call.

## Declare the hooks in the type system

Augment `FlowsHooks` in the root module. The specifier must be
`"@smthrs/plugin"`, because that is where the interface is declared:

```ts
import type { ParallelHook, WaterfallHook } from "@smthrs/plugin"
import type * as Effect from "effect/Effect"

interface Prompt {
  readonly system: ReadonlyArray<string>
}

interface Session {
  readonly id: string
}

declare module "@smthrs/plugin" {
  interface FlowsHooks {
    /** Rewrites the prompt before the host sends it. */
    readonly promptRewrite: WaterfallHook<(prompt: Prompt) => Effect.Effect<Prompt | void>>
    /** Observes the start of a session. */
    readonly sessionStart: ParallelHook<(session: Session) => Effect.Effect<void>>
  }
}
```

Pick the kind deliberately: it decides what the caller gets back and what a
failing handler does. See [Hook kinds](../concepts/hook-kinds.md).

## Supply the matching runtime catalog

The type system cannot enumerate an augmentable interface, so the kernel needs
the same names again as data. Spread `engineHooks` so the config lifecycle stays
available to plugins:

```ts
import { engineHooks } from "@smthrs/plugin"

export const hooks = Object.freeze(
  {
    ...engineHooks,
    promptRewrite: "waterfall",
    sessionStart: "parallel"
  } as const
)
```

This catalog is what the `unknown_hook` guard checks a plugin against. A plugin
that declares a hook you did not list fails at startup with the plugin name, the
hook name, and the path, rather than declaring a handler nobody will ever call.

## Resolve for your host

Pass the catalog, and pass `target: "harness"` unless your host is the engine:

```ts
import { type FlowsHooks, Kernel, type PluginInput } from "@smthrs/plugin"
import type { FlowsConfig } from "@smthrs/plugin/Config"

export const makeKernel = (plugins: PluginInput<FlowsHooks> = [], config: FlowsConfig = {}) =>
  Kernel.make<FlowsHooks>(plugins, config, { target: "harness", hooks })
```

`target` defaults to `"engine"`, so a plugin declared `apply: "harness"` is
dropped by a bare `Kernel.make`. See
[Include a plugin conditionally](./select-plugins.md).

## Dispatch only what you declared

Give each hook a named dispatch function, so callers do not repeat the merge
function and the hook name:

```ts
import type * as Plugins from "@smthrs/plugin/Plugins"

export const rewritePrompt = (plugins: Plugins.Service<FlowsHooks>, initial: Prompt) =>
  plugins.waterfall("promptRewrite", initial, (_previous, next) => next)

export const sessionStarted = (plugins: Plugins.Service<FlowsHooks>, session: Session) =>
  plugins.parallel("sessionStart", session)
```

Dispatch is closed: the kernel runs only the catalog you supplied, and a
dispatcher method accepts only hook names of its own kind. Nothing dispatches a
hook on your behalf.

## When to use a standalone interface instead

Module augmentation gives one process-wide catalog. That is the right shape for
a host that owns its process, and it is what the shared `Plugins` service tag
and its layers hold.

A host that must not widen the shared catalog declares its own interface and
carries the dispatcher itself:

```ts
import type { SequentialHook } from "@smthrs/plugin"
import * as Plugins from "@smthrs/plugin/Plugins"
import * as Resolve from "@smthrs/plugin/Resolve"
import * as Effect from "effect/Effect"

interface IsolatedHooks {
  readonly isolated: SequentialHook<(value: number) => Effect.Effect<number>>
}

const program = Effect.gen(function*() {
  const resolved = yield* Resolve.resolve<IsolatedHooks>(
    { name: "flows-plugin-double", hooks: { isolated: (value) => Effect.succeed(value * 2) } },
    { hooks: { isolated: "sequential" } }
  )
  return yield* Plugins.make<IsolatedHooks>(resolved).sequential("isolated", 21)
})
```

A `Plugins.Service<IsolatedHooks>` held directly does not use the shared
`Plugins` tag, `Plugins.layer`, or `Plugins.layerNoop`. Those three target the
augmented `FlowsHooks` catalog only.
