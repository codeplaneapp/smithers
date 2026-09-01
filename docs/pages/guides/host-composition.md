---
description: "Which layers to provide on Node and in a browser, and which parts of the composition stay the application's own."
---

# Host composition

A flow depends on contracts, not on a host. Composition is where a program says
which implementations of those contracts it wants. This guide shows the two
compositions the release supports.

## The shape of a composition

Every durable program provides four things:

1. **Storage.** A `SqlClient`, the migration ladder, and the journal, run,
   attempt, cache, and durable-engine-state stores.
2. **The engine.** `EngineStore` over that storage, plus the flow registrations
   it drives.
3. **Host services.** The closed host list, decorated by the capability kernel:
   filesystem, process spawning, `Jj`, crypto, clock, randomness.
4. **Policy.** The seams whose default you may want to replace, such as
   `Inconsistency` for cache-conflict verdicts, `OwnerIdentity`, and the
   boundary and sandbox implementations.

[`@smthrs/flows/NodeRuntime`](/api/flows#noderuntime) packages the first two on
Node. Its lower-level `layer` constructor leaves the host composition to the
application; `layerHost` supplies the contained, capability-guarded Node host
for applications that want the batteries-included composition.

## Node

```ts
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"

const runtime = NodeRuntime.layer({
  filename: ".flows/engine.db",
  workspaceRoot: process.cwd(),
  owner: { hostId: "example" },
  isAlive
}, boundary, sandbox, registerFlows)
```

`NodeRuntime.storage` opens the SQLite database, runs the migrations, and
provides the stores, `OwnerIdentity`, `Workspace`, and a filesystem artifact
store. `layer` and `make` add `EngineStore` over that and run `registerFlows`
as the final startup phase. `layerHost` additionally installs the contained
Node host and signal-driven graceful shutdown. Engine checkpoint operations use
a private repository-bound `Jj`; flow actions see only the guarded host service.

The lower-level `layer` does not install `NodeHost.layer` or the guarded
`HostServices` kernel. `Jj`, Effect's `FileSystem`, and Effect's `Crypto` stay
requirements of that returned layer, and `StepBoundary` and `WorkspaceSandbox`
are arguments. Use `layerHost` when the standard contained Node composition and
its capability policy are appropriate.

The durable engine is Node-only. Opening a durable database under Bun fails with
`unsupported_runtime`; Bun runs the applications and the non-durable packages.

Worked example: [`examples/src/durable-layer.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/durable-layer.ts).

## Browser

Browser support is a bundling claim, not a deployment claim. Twenty-eight entry
points bundle under esbuild's browser platform, and
[`scripts/browser-check.mjs`](https://github.com/smithersai/smithers/blob/main/scripts/browser-check.mjs)
executes that claim on every build. [Browser support](/architecture/browser-support)
lists every entry point and the seven that stay Node-only.

```ts
import { BrowserHost } from "@smthrs/platform-browser/BrowserHost"

const host = BrowserHost.layer({ bash, fs, jj })
```

`@smthrs/platform-browser` supplies Effect's `FileSystem` over a
ZenFS-shaped promises API and Effect's `ChildProcessSpawner` over an in-page
bash interpreter. `@smthrs/jj/browser/BrowserJj` runs jj-lib compiled to
`wasm32-wasip1` over an injected virtual filesystem.

`@smthrs/journal` bundles because it depends on the `DurableWriter` contract
rather than on a driver. Durable execution itself is unsupported in browsers
and edge workers in rc.0, even if an application supplies a SQL client. A
browser bundle can author and inspect flows, but the supported durable host is
Node.js with local SQLite.

## Capability decoration

Host access is closed and decorated. `@smthrs/kernel` wraps each host service so
a call is checked against the capability set the run holds, and a decision is
journalled. That is what makes a hostile flow body a bounded problem rather than
an unbounded one, and it is why the host bundle is a separate layer from the
engine. See [hosts and capabilities](/concepts/hosts-and-capabilities).

## What no host installs

- A supervisor process. Recovery is a running engine with the flow registered.
- A cross-process event bus. Wakes land through the heartbeat sweep.
- A multi-node lease service or an external process supervisor. Same-host child
  processes are tracked by the contained host's `ProcessLedger`; abandoned runs
  still require another registered engine process to reclaim them.

See [known limitations](/release/known-limitations).
