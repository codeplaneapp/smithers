# @smthrs/flows

This package declares `effect` as an exact
`4.0.0-rc.108` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://flows.smithers.sh

Convenience barrel for the complete durable flows architecture. Each package
is re-exported as a namespace so consumers can opt into one dependency
without flattening neighboring service constructors; `namespaces` lists those
runtime namespace names.

```sh
pnpm add @smthrs/flows@next
```

```ts
import { Engine, EngineStore, Journal, Kernel } from "@smthrs/flows"
```

## Public API

| Namespace                                                                                                                                                                          | Re-exported package                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `Artifacts`                                                                                                                                                                        | `@smthrs/artifacts`                                   |
| `Canonical`                                                                                                                                                                        | `@smthrs/canonical`                                   |
| `Capability`                                                                                                                                                                       | `@smthrs/capability`                                  |
| `Crypto`                                                                                                                                                                           | `@smthrs/crypto`                                      |
| `Database`                                                                                                                                                                         | `@smthrs/database`                                    |
| `Engine`                                                                                                                                                                           | `@smthrs/engine`                                      |
| `EngineStore`                                                                                                                                                                      | `@smthrs/engine-store`                                |
| `Action`, `DurableClock`, `DurableDeferred`, `DurableQueue`, `Flow`, `FlowRuntime`, `Graph`, `HumanTask`, `Interpreter`, `Poll`, `RetryPolicy`, `Sleep`, `StepIdentity`, `WaitFor` | `@smthrs/flow` (re-exported flat)                     |
| `Jj`                                                                                                                                                                               | `@smthrs/jj`                                          |
| `Journal`                                                                                                                                                                          | `@smthrs/journal`                                     |
| `Kernel`                                                                                                                                                                           | `@smthrs/kernel`                                      |
| `Keys`                                                                                                                                                                             | `@smthrs/keys`                                        |
| `Observability`                                                                                                                                                                    | `@smthrs/observability`                               |
| `Plan`                                                                                                                                                                             | `@smthrs/plan`                                        |
| `RunStore`                                                                                                                                                                         | `@smthrs/run-store`                                   |
| `Sandbox`                                                                                                                                                                          | `@smthrs/sandbox`                                     |
| `StepCache`                                                                                                                                                                        | `@smthrs/step-cache`                                  |
| `Sync`                                                                                                                                                                             | `@smthrs/sync`                                        |
| `TimeTravel`                                                                                                                                                                       | `@smthrs/time-travel` (service key, re-exported flat) |

Namespacing preserves APIs such as `Kernel.ChildProcessSpawner.layerNoop` and
`RunStore.RunStore.layer`. Depend on an individual package when a narrower
dependency surface is preferable.

The `@smthrs/platform-*` bundles are deliberately absent, for the same reason
`effect`'s index does not re-export `@effect/platform-node`: a platform bundle
is chosen by the program that runs, not by the library it depends on.

## The barrel is a browser entry point

`@smthrs/flows` bundles for a browser, and `pnpm run browser` gates it along
with every package root it re-exports.
[Browser support](https://smithers.sh/architecture/browser-support) lists the
gated entry points; that page tracks the gate's own contract, so it is the one
place the list is written down.

Bundling is not durable execution. The rc.0 durable engine is supported only on
Node.js >= 22.19.0 with local SQLite; browser and edge runtimes may author and
inspect declarations but are not supported durable hosts, even with another
SQL client.

Platform implementations are never re-exported through the namespaces here
either. Import `@smthrs/platform-node`, `@smthrs/platform-bun`,
`@smthrs/kernel/test/TestHost`, `@smthrs/database/node/NodeDatabase`, or
`@smthrs/journal/test/TestJournal` directly. See
[browser support](https://smithers.sh/architecture/browser-support).

## The Node runtime

`@smthrs/flows/NodeRuntime` is the one module here that a host program calls
to stand a durable engine up. `layer` composes storage and the engine and
leaves the host to the caller; `layerHost` supplies the host too:

```ts
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"

const runtime = NodeRuntime.layerHost(
  {
    filename: ".flows/engine.db",
    workspaceRoot: ".",
    owner: { hostId: "local-worker" }
  },
  registerFlows
)
```

That call adds the contained Node host, the kernel's guarded host surface over
an unattended `GrantStore`, the default step boundary and workspace sandbox, a
process-table liveness probe, and signal handling that releases every run the
host owns before it shuts down.

The runtime journal queue is fixed at 1,024 entries and rejects overflow. Jj
snapshot bookkeeping uses an engine-private service; `HostOptions.rules`
governs only action-facing host access. Signal names are validated and
deduplicated before installation, and `shutdownTimeoutMs` must be an integer
from 0 through 2,147,483,647. A second signal, or a shutdown exceeding that
deadline, exits with the signal's default status.

## Documentation

- [Quickstart](https://flows.smithers.sh/quickstart/): a durable flow on SQLite,
  end to end.
- [Stand up a durable Node runtime](https://flows.smithers.sh/guides/stand-up-a-node-runtime/):
  `layerHost`, `layer`, `make`, and `storage`.
- [Run a child flow in a sandbox](https://flows.smithers.sh/guides/run-a-child-flow-in-a-sandbox/):
  the `SandboxedFlow` tier.
- [API reference](https://flows.smithers.sh/reference/api/): every public export.
