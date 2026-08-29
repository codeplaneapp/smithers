---
description: "The umbrella barrel: every engine package re-exported as a namespace, in one dependency."
---

# @smthrs/flows

The umbrella barrel. It re-exports the engine packages as namespaces, so one dependency gives you the whole surface without collapsing each package's `make` / `makeNoop` / `layerNoop` trio into a shared namespace. There are two exceptions: `@smthrs/flow`'s authoring model is re-exported flat, so `Flow`, `Action`, and their siblings sit at the top level, and `@smthrs/time-travel` contributes the `TimeTravel` *service key* flat rather than a namespace, so `yield* TimeTravel` is the whole onboarding and `TimeTravel.layer` provides it.

The `@smthrs/platform-*` bundles are deliberately absent, for the same reason `effect`'s index does not re-export `@effect/platform-node`: a platform bundle is chosen by the program that runs, not by the library it depends on. Import [`@smthrs/platform-node`](/api/platform-node), [`@smthrs/platform-bun`](/api/platform-bun), or [`@smthrs/platform-browser`](/api/platform-browser) directly.

```ts
import { Action, Flow, Kernel, RunStore } from "@smthrs/flows"
import * as Schema from "effect/Schema"

const jj = Kernel.Jj.layerNoop({})
const runs = RunStore.RunStore.layer
const Compile = Action.make("example/Compile", {
  payload: { target: Schema.String },
  success: Schema.String
})
const Build = Flow.make("example/Build", {
  payload: { target: Schema.String },
  success: Schema.String,
  body: (payload) => Compile.call(payload)
})
```

This entry point bundles for the browser: it re-exports only package roots, each of which is itself browser-safe, and `pnpm run browser` gates all of them. 
:::warning[Bundling is not running]
The durable composition still needs a SQL client behind the `DurableWriter` contract, and the only ones shipped here are `node:sqlite`-backed.
:::

## Entry point

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/flows` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/flows/src/index.ts) | Node and browser |

## Namespaces

| Namespace | Package | Reference |
| --- | --- | --- |
| `Canonical` | `@smthrs/canonical` | [Canonical](/api/canonical) |
| `Capability` | `@smthrs/capability` | [Capability](/api/capability) |
| `Crypto` | `@smthrs/crypto` | [Crypto](/api/crypto) |
| `Database` | `@smthrs/database` | [Database](/api/database) |
| `Engine` | `@smthrs/engine` | [Engine](/api/engine) |
| `Action`, `DurableClock`, `DurableDeferred`, `DurableQueue`, `Flow`, `FlowRuntime`, `RetryPolicy`, `StepIdentity` | `@smthrs/flow` (re-exported flat) | [Flow](/api/flow) |
| `EngineStore` | `@smthrs/engine-store` | [EngineStore](/api/engine-store) |
| `Jj` | `@smthrs/jj` | [Jj](/api/jj) |
| `Journal` | `@smthrs/journal` | [Journal](/api/journal) |
| `RunStore` | `@smthrs/run-store` | [RunStore](/api/run-store) |
| `StepCache` | `@smthrs/step-cache` | [StepCache](/api/step-cache) |
| `Kernel` | `@smthrs/kernel` | [Kernel](/api/kernel) |
| `Keys` | `@smthrs/keys` | [Keys](/api/keys) |
| `Plan` | `@smthrs/plan` | [Plan](/api/plan) |
| `Artifacts` | `@smthrs/artifacts` | [Artifacts](/api/artifacts) |
| `Sandbox` | `@smthrs/sandbox` | [Sandbox](/api/sandbox) |
| `Sync` | `@smthrs/sync` | [Sync](/api/sync) |
| `TimeTravel` | `@smthrs/time-travel` (the service key, re-exported flat) | [TimeTravel](/api/time-travel) |

The rest of `@smthrs/time-travel` (`Frame`, `TimeTravelStore`, its two store layers, and `EffectBoundary`) is reached through that package directly, not through the barrel.

## Own exports

| Export | Kind | Notes |
| --- | --- | --- |
| `namespaces` | const | the namespace names above, sorted |

`namespaces` is the barrel's one runtime value. A pure re-export module carries no executable statements, so the package's 100% coverage gate had an empty denominator and could never go red. This constant gives the gate a real denominator, and the barrel test pins it against the derived `packages/*` universe so it cannot drift from the re-exports.

## When to use the barrel

Take the barrel when you want the whole engine in one dependency. Take the individual packages when you want a narrower dependency footprint.
