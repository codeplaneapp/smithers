# @smthrs/flows

The aggregate entry point re-exports every durable-engine package without
flattening neighboring constructors. [`@smthrs/flow`](/api/flow) authoring
names are flat, and `TimeTravel` is a flat service key; infrastructure packages
remain namespaces.

```sh
pnpm add @smthrs/flows@rc
```

```ts
import { Action, Flow, Kernel, RunStore } from "@smthrs/flows"
```

The root entry point bundles for browsers, but rc.0 durable execution is
supported only on Node.js >= 22.19.0 with local SQLite. Browser and edge
runtimes may author and inspect declarations; supplying another SQL client does
not make them supported durable hosts.

## Aggregate exports

<!-- generated:namespaces -->

Platform bundles are deliberately absent. A program chooses
`@smthrs/platform-node`, `@smthrs/platform-bun`, or
`@smthrs/platform-browser` directly.

The `Capability` namespace re-exports `@smthrs/capability`; its exact-resource
bounds, pattern grammar, and permission failures are documented in the
[capability API](/api/capability).

The `Plan` namespace re-exports [`@smthrs/plan`](/api/plan), which owns step
identity, graph compilation, static effect declarations, and plan storage.

The `Journal` namespace re-exports [`@smthrs/journal`](/api/journal), which owns
the append-only event record every durable run is replayed from, and the
redaction rules that keep a credential out of both a committed row and a log
line.

## NodeRuntime

`@smthrs/flows/NodeRuntime` is the only supported durable-runtime subpath in
rc.0. `layer` leaves host services, the step boundary, and workspace sandbox to
the caller. `layerHost` supplies the contained Node host, guarded action
surface, storage, engine, liveness probe, and bounded signal shutdown.

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

The journal queue has capacity 1,024 and rejects overflow. Artifacts live next
to the database under `.flows/objects`. Engine snapshot bookkeeping uses a
private Jj service; `HostOptions.rules` controls only action-facing authority.
Signals are validated and deduplicated before installation, and
`shutdownTimeoutMs` must be an integer from 0 through 2,147,483,647.

<!-- generated:node-runtime -->

Use individual `@smthrs/*` packages when a smaller dependency surface is
preferable.
