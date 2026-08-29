# `@smthrs/flows`

The barrel package. It re-exports every engine package as a namespace so one
dependency yields the whole engine surface. Its only API of its own is
`namespaces`, the runtime list of the re-exported namespace names — also the
barrel's one executable statement, so the package's 100% coverage gate has a
real denominator instead of an empty one (issue #169).

```ts
import { Engine, Kernel, Journal } from "@smthrs/flows"
```

| Namespace     | Package                  | Reference                              |
| ------------- | ------------------------ | -------------------------------------- |
| `Canonical`   | `@smthrs/canonical`     | [canonical](canonical.md)              |
| `Capability`  | `@smthrs/capability`    | [capability](capability.md)            |
| `Crypto`      | `@smthrs/crypto`        | [crypto](crypto.md)                    |
| `Database`    | `@smthrs/database`     | [database](database.md)                |
| `Engine`      | `@smthrs/engine`       | [engine](engine.md)                    |
| `Flow`, `Action`, `RetryPolicy`, `DurableDeferred`, `DurableClock`, `DurableQueue`, `FlowRuntime`, `StepIdentity` | `@smthrs/flow` (flat) | [flow](flow.md) |
| `EngineStore` | `@smthrs/engine-store` | [engine-store](engine-store.md)        |
| `Jj`          | `@smthrs/jj`           | [jj](jj.md)                            |
| `Journal`     | `@smthrs/journal`      | [journal](journal.md)                  |
| `RunStore`    | `@smthrs/run-store`    | [run-store](run-store.md)              |
| `StepCache`   | `@smthrs/step-cache`   | [step-cache](step-cache.md)            |
| `Kernel`      | `@smthrs/kernel`       | [kernel](kernel.md)                    |
| `Keys`        | `@smthrs/keys`         | [keys](keys.md)                        |
| `Sandbox`     | `@smthrs/sandbox`      | [sandbox](sandbox.md)                  |
| `Sync`        | `@smthrs/sync`         | [sync](sync.md)                        |
| `TimeTravel`  | `@smthrs/time-travel` (service key, flat) | [time-travel](time-travel.md) |

Each package is exported as a namespace rather than flattened, so every
package keeps its own `make` / `makeNoop` / `layerNoop` trio without colliding
with its neighbours: `Kernel.ChildProcessSpawner.layerNoop`, `RunStore.RunStore.layer`.

The `@smthrs/platform-*` bundles are deliberately not among them, for the same
reason `effect`'s index does not re-export `@effect/platform-node`: a platform
bundle is chosen by the program that runs, not by the library it depends on.

## `NodeRuntime`

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

See the [durable engine guide](../guides/durable-engine.md).

## When not to use it

Depend on the individual `@smthrs/*` packages when you want a narrower
dependency footprint, or when a runtime target cannot carry every engine
package. The barrel pulls in every one of them.

**A browser is not one of those targets.** Every package root the barrel
re-exports bundles for a browser, and `pnpm run browser` gates `@smthrs/flows`
itself alongside them — see [browser support](../architecture/browser-support.md).
Bundling is still weaker than running: the durable composition needs a SQL
client behind the `DurableWriter` contract, and the only ones shipped here are
`node:sqlite`-backed. The namespaces here also carry contracts only —
`Journal.TestJournal` does not exist; it lives at
`@smthrs/journal/test/TestJournal`, and the host bundles live at
`@smthrs/platform-node`, `@smthrs/platform-bun`, and
`@smthrs/platform-browser`.

The barrel deliberately excludes the agent-layer packages, which sit above the
engine, and the vendor host adapters `@smthrs/host-cloudflare` and
`@smthrs/host-vercel`, which live in the
[plugins repository](https://github.com/smithersai/plugins).

See the [package map](../architecture/package-map.md) for the dependency
direction between the packages this barrel re-exports.
