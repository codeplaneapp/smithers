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

`@smthrs/flows/NodeRuntime` packages the first two on Node. The last two stay
yours by design: a host bundle that installed itself would decide your
capability policy for you.

## Node

```ts
import { NodeRuntime } from "@smthrs/flows/NodeRuntime"

const runtime = NodeRuntime.layer({
  filename: ".flows/engine.db",
  boundary,
  sandbox
})
```

`NodeRuntime.storage` opens the SQLite database, runs the migrations, and
provides the stores, `OwnerIdentity`, `Workspace`, and a filesystem artifact
store. `layer` and `make` add `EngineStore` over that and run `registerFlows`
as the final startup phase. Shutdown is scope closure, and nothing installs a
process or signal handler.

What it does not install: `NodeHost.layer` and the guarded `HostServices`
kernel. `Jj`, Effect's `FileSystem`, and Effect's `Crypto` stay requirements of
the returned layer, and `StepBoundary` and `WorkspaceSandbox` are arguments. Add
`@smthrs/platform-node` for the host services and `@smthrs/kernel` for the
capability decoration.

The durable engine is Node-only. Opening a durable database under Bun fails with
`unsupported_runtime`; Bun runs the applications and the non-durable packages.

Worked example: [`examples/src/durable-layer.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/durable-layer.ts).

## Browser

Browser support is a bundling claim, not a deployment claim. Twenty-four entry
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

What a browser deployment still needs, and what this release does not ship, is a
SQL client behind the `DurableWriter` contract. `@smthrs/journal` bundles
because it depends on the contract rather than on a driver; a browser
application supplies its own client, for example Effect's sqlite-wasm OPFS
worker. Until it does, a browser bundle can author and inspect but not durably
execute.

## Capability decoration

Host access is closed and decorated. `@smthrs/kernel` wraps each host service so
a call is checked against the capability set the run holds, and a decision is
journalled. That is what makes a hostile flow body a bounded problem rather than
an unbounded one, and it is why the host bundle is a separate layer from the
engine. See [hosts and capabilities](/concepts/hosts-and-capabilities).

## What no host installs

- A supervisor process. Recovery is a running engine with the flow registered.
- A cross-process event bus. Wakes land through the heartbeat sweep.
- A durable process registry. Cancelling a run kills the process groups it
  spawned; hard-killing the engine does not.

See [known limitations](/release/known-limitations).
