# @smthrs/flows

Convenience barrel for the complete durable flows architecture. Each package
is re-exported as a namespace so consumers can opt into one dependency
without flattening neighboring service constructors; `namespaces` lists those
runtime namespace names.

```sh
pnpm add @smthrs/flows
```

```ts
import { Engine, EngineStore, Journal, Kernel } from "@smthrs/flows"
```

## Public API

| Namespace                                                                                                         | Re-exported package                                   |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `Canonical`                                                                                                       | `@smthrs/canonical`                                   |
| `Capability`                                                                                                      | `@smthrs/capability`                                  |
| `Crypto`                                                                                                          | `@smthrs/crypto`                                      |
| `Database`                                                                                                        | `@smthrs/database`                                    |
| `Engine`                                                                                                          | `@smthrs/engine`                                      |
| `Flow`, `Action`, `RetryPolicy`, `DurableDeferred`, `DurableClock`, `DurableQueue`, `FlowRuntime`, `StepIdentity` | `@smthrs/flow` (re-exported flat)                     |
| `EngineStore`                                                                                                     | `@smthrs/engine-store`                                |
| `Jj`                                                                                                              | `@smthrs/jj`                                          |
| `Journal`                                                                                                         | `@smthrs/journal`                                     |
| `RunStore`                                                                                                        | `@smthrs/run-store`                                   |
| `StepCache`                                                                                                       | `@smthrs/step-cache`                                  |
| `Kernel`                                                                                                          | `@smthrs/kernel`                                      |
| `Keys`                                                                                                            | `@smthrs/keys`                                        |
| `Sandbox`                                                                                                         | `@smthrs/sandbox`                                     |
| `Sync`                                                                                                            | `@smthrs/sync`                                        |
| `TimeTravel`                                                                                                      | `@smthrs/time-travel` (service key, re-exported flat) |

Namespacing preserves APIs such as `Kernel.ChildProcessSpawner.layerNoop` and
`RunStore.RunStore.layer`. Depend on an individual package when a narrower
dependency surface is preferable.

The `@smthrs/platform-*` bundles are deliberately absent, for the same reason
`effect`'s index does not re-export `@effect/platform-node`: a platform bundle
is chosen by the program that runs, not by the library it depends on.

## The barrel is a browser entry point

`@smthrs/flows` bundles for a browser, and `pnpm run browser` gates it along
with every package root it re-exports: `@smthrs/canonical`,
`@smthrs/capability`, `@smthrs/crypto`, `@smthrs/jj`,
`@smthrs/jj/browser/BrowserJj`, `@smthrs/platform-browser`,
`@smthrs/platform-browser/BrowserHost`, `@smthrs/sandbox`, `@smthrs/kernel`,
`@smthrs/keys`, `@smthrs/database`, `@smthrs/journal`, `@smthrs/run-store`,
`@smthrs/step-cache`, `@smthrs/flow`, `@smthrs/engine`,
`@smthrs/engine-store`, `@smthrs/sync`, and `@smthrs/time-travel`.

Bundling is a weaker claim than running. The durable composition still needs a
SQL client behind the `DurableWriter` contract, and the only ones shipped here
are `node:sqlite`-backed, so a browser deployment must supply its own.

Platform implementations are never re-exported through the namespaces here
either. Import `@smthrs/platform-node`, `@smthrs/platform-bun`,
`@smthrs/kernel/test/TestHost`, `@smthrs/database/node/NodeDatabase`, or
`@smthrs/journal/test/TestJournal` directly. See [browser support](../../docs/pages/architecture/browser-support.md).

## The Node runtime

`@smthrs/flows/NodeRuntime` is the one module here that a host program calls
to stand a durable engine up. `layer` composes storage and the engine and
leaves the host to the caller; `layerHost` supplies the host too:

```ts
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"

const runtime = NodeRuntime.layerHost(
  { filename: ".flows/engine.sqlite", owner: { hostId: "local-worker" } },
  registerFlows
)
```

That call adds the contained Node host, the kernel's guarded host surface over
an unattended `GrantStore`, the default step boundary and workspace sandbox, a
process-table liveness probe, and signal handling that releases every run the
host owns before it shuts down.

Two details of that composition are decisions rather than defaults.
`NodeRuntime.engineRules` is merged underneath `HostOptions.rules`, allowing the
`jj:snapshot` and `jj:restore` the ENGINE takes for a compensable action's
pre-image; without them a host with no jj policy could not run a compensable
action at all, and a program that denies `jj:snapshot` still denies it. And the
signal handler keeps two escapes, because installing it removes Node's default
disposition: a second signal leaves immediately, and a shutdown that outlasts
`HostOptions.shutdownTimeoutMs` leaves anyway, both with the status the default
disposition would have produced.

See the [documentation index](../../docs/README.md) and
[flows reference](../../docs/pages/api/flows.md).
