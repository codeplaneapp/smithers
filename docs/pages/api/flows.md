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
| `@smthrs/flows` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/flows/src/index.ts) | Node and browser |

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

## API reference

The barrel package. It re-exports every engine package as a namespace so one
dependency yields the whole engine surface. Its only API of its own is
`namespaces`, the runtime list of the re-exported namespace names: also the
barrel's one executable statement, so the package's 100% coverage gate has a
real denominator instead of an empty one (issue #169).

```ts
import { Engine, Kernel, Journal } from "@smthrs/flows"
```

| Namespace     | Package                  | Reference                              |
| ------------- | ------------------------ | -------------------------------------- |
| `Canonical`   | `@smthrs/canonical`     | [canonical](/api/canonical)              |
| `Capability`  | `@smthrs/capability`    | [capability](/api/capability)            |
| `Crypto`      | `@smthrs/crypto`        | [crypto](/api/crypto)                    |
| `Database`    | `@smthrs/database`     | [database](/api/database)                |
| `Engine`      | `@smthrs/engine`       | [engine](/api/engine)                    |
| `Flow`, `Action`, `RetryPolicy`, `DurableDeferred`, `DurableClock`, `DurableQueue`, `FlowRuntime`, `StepIdentity` | `@smthrs/flow` (flat) | [flow](/api/flow) |
| `EngineStore` | `@smthrs/engine-store` | [engine-store](/api/engine-store)        |
| `Jj`          | `@smthrs/jj`           | [jj](/api/jj)                            |
| `Journal`     | `@smthrs/journal`      | [journal](/api/journal)                  |
| `RunStore`    | `@smthrs/run-store`    | [run-store](/api/run-store)              |
| `StepCache`   | `@smthrs/step-cache`   | [step-cache](/api/step-cache)            |
| `Kernel`      | `@smthrs/kernel`       | [kernel](/api/kernel)                    |
| `Keys`        | `@smthrs/keys`         | [keys](/api/keys)                        |
| `Sandbox`     | `@smthrs/sandbox`      | [sandbox](/api/sandbox)                  |
| `Sync`        | `@smthrs/sync`         | [sync](/api/sync)                        |
| `TimeTravel`  | `@smthrs/time-travel` (service key, flat) | [time-travel](/api/time-travel) |

Each package is exported as a namespace rather than flattened, so every
package keeps its own `make` / `makeNoop` / `layerNoop` trio without colliding
with its neighbours: `Kernel.ChildProcessSpawner.layerNoop`, `RunStore.RunStore.layer`.

The `@smthrs/platform-*` bundles are deliberately not among them, for the same
reason `effect`'s index does not re-export `@effect/platform-node`: a platform
bundle is chosen by the program that runs, not by the library it depends on.

### `NodeRuntime`

`@smthrs/flows/NodeRuntime` is a subpath export, not part of the barrel:
importing it opens a `node:sqlite` database, so the browser-safe root must not
reach it.

| Export | Kind | Notes |
| --- | --- | --- |
| `Options`, `HostOptions` | interfaces | configuration for `layer` and for `layerHost` |
| `storage` | layer constructor | the migrated database, stores, owner minter, workspace, and artifact store, without an engine |
| `make`, `layer` | constructor and layer | storage plus the engine; the host, the step boundary, and the workspace sandbox are the caller's |
| `layerHost` | layer | the whole Node host, kernel, storage, and engine from one call |
| `engineRules` | rule list | the `jj:snapshot` / `jj:restore` the ENGINE takes for a compensable action's pre-image, merged under `HostOptions.rules` |
| `defaultShutdownTimeoutMs`, `signalExitCode` | constant and function | the graceful-shutdown deadline, and the status a signalled host leaves with |

`layerHost` is `layer` with every remaining decision defaulted: the contained
Node host, the kernel's guarded surface over an unattended `GrantStore`, the
default step boundary and workspace sandbox, `HostLiveness.isAlive`, and
`SIGINT`/`SIGTERM` handling that releases the runs this host owns. Its options
add `rules` (the capabilities the host grants without asking), `signals` (an
empty list installs none), `shutdownTimeoutMs` (how long a graceful shutdown may
take before the host leaves anyway), and `containment` (process-group and reaper
options).

Two of its defaults are decisions rather than conveniences. `engineRules` is
merged underneath `rules`, because the engine takes a compensable action's jj
pre-image through the same guarded `Jj` the body sees and a host with no jj
policy could otherwise not run a compensable action at all; a program that
denies `jj:snapshot` still denies it. And the signal handler keeps two escapes,
because installing it removes Node's default disposition: a second signal leaves
immediately, and a shutdown that outlasts `shutdownTimeoutMs` leaves anyway,
both with `signalExitCode` (130 for `SIGINT`, 143 for `SIGTERM`).

See the [durable engine guide](/guides/durable-engine).

### When not to use it

Depend on the individual `@smthrs/*` packages when you want a narrower
dependency footprint, or when a runtime target cannot carry every engine
package. The barrel pulls in every one of them.

**A browser is not one of those targets.** Every package root the barrel
re-exports bundles for a browser, and `pnpm run browser` gates `@smthrs/flows`
itself alongside them: see [browser support](/architecture/browser-support).
Bundling is still weaker than running: the durable composition needs a SQL
client behind the `DurableWriter` contract, and the only ones shipped here are
`node:sqlite`-backed. The namespaces here also carry contracts only , 
`Journal.TestJournal` does not exist; it lives at
`@smthrs/journal/test/TestJournal`, and the host bundles live at
`@smthrs/platform-node`, `@smthrs/platform-bun`, and
`@smthrs/platform-browser`.

The barrel deliberately excludes the agent-layer packages, which sit above the
engine, and the vendor host adapters `@smthrs/host-cloudflare` and
`@smthrs/host-vercel`, which live in the
[plugins repository](https://github.com/smithersai/plugins).

See the [package map](/architecture/package-map) for the dependency
direction between the packages this barrel re-exports.
