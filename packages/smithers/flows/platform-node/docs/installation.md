---
title: "Installation"
description: "Install @smthrs/platform-node, the peers and host prerequisites it needs, its entry points, and the packages a real host composition adds."
sidebar:
  order: 1
---

## Get the package

`@smthrs/platform-node` is not on npm at 1.0.0-rc.0. It ships as a member of
the [smithers repository](https://github.com/smithersai/smithers) workspace, so
using it today means working from a checkout:

```bash
git clone https://github.com/smithersai/smithers.git
cd smithers
pnpm install
```

Code that consumes it lives in that workspace too, either an existing package
or one you add, and depends on it with a workspace specifier:

```json
{
  "dependencies": {
    "@smthrs/platform-node": "workspace:*"
  }
}
```

## Peers

`@effect/platform-node` and `effect` are peer
dependencies, so your project pins their versions rather than inheriting a
second copy. `@smthrs/platform-node` declares `4.0.0-rc.112` for both:

```bash
pnpm add @effect/platform-node@4.0.0-rc.112 effect@4.0.0-rc.112
```

The Effect Node adapter owns its `@effect/platform-node-shared` implementation
dependency; consumers do not need to declare that package separately.

Its own runtime dependencies, [`@smthrs/jj`](/api/jj) and
[`@smthrs/kernel`](/api/kernel), resolve from the same workspace.

The package ships ESM, CommonJS, and TypeScript declarations.

## Host requirements

| Requirement                                        | Why it is needed                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Node.js 22.19.0 or later                           | the minimum this package's `engines` field declares                                                       |
| a POSIX host                                       | Windows has none of the primitives below and is unsupported                                               |
| CPython 3 at `/usr/bin/python3`                    | `AtomicFileSystem` runs every filesystem syscall through it                                               |
| that interpreter's `os` module supporting `dir_fd` | with `O_NOFOLLOW` and `O_DIRECTORY`, for `open`, `mkdir`, `readlink`, `rename`, `rmdir`, `stat`, `unlink` |
| `jj` on `PATH`                                     | only for `Jj` operations; every other tag works without it                                                |

### The interpreter fails late, on purpose

`NodeHost.layer` builds cleanly on a host with no CPython 3. The executable is
re-validated on every request rather than once at construction, because the
file a path names can be replaced while a host runs, and a check that happened
only at boot would be a check about a file that is no longer there.

The consequence is that on `node:22-slim`, `node:22-alpine`, or a distroless
image the layer builds, the run starts, and the first guarded filesystem call
inside a flow body fails with `PermissionDenied`. Install `python3`, or point
the adapter at the interpreter you do have:

```ts
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"

const filesystem = AtomicFileSystem.layerWith({ executable: "/usr/local/bin/python3" })
```

For the rest of what `layerWith` configures, see
[Configure the filesystem helper](./guides/configure-the-filesystem-helper.md).

Without `jj` on `PATH`, `Jj` operations fail with a typed `JjError` whose code
is `not_installed`. Nothing else in the bundle is affected.

## Import forms

The root entry point re-exports three modules as namespaces:

```ts
import { HostLiveness, NodeHost, ProcessReaper, ScopedProcess } from "@smthrs/platform-node"
```

Each module is also importable from its own subpath, which is the form the
[API reference](./api.md) uses:

```ts
import * as HostLiveness from "@smthrs/platform-node/HostLiveness"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import * as ProcessReaper from "@smthrs/platform-node/ProcessReaper"
```

`AtomicFileSystem` is deliberately not in the barrel. Reach it through its own
subpath, or as a re-export off `NodeHost`:

```ts
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
// or
import { NodeHost } from "@smthrs/platform-node"
const filesystem = NodeHost.AtomicFileSystem.layer
```

Two subpath shapes are blocked in the export map:
`@smthrs/platform-node/internal/*` and `@smthrs/platform-node/*/index`.
`@smthrs/platform-node/package.json` is exported.

## Entry points

| Import                                   | Source                                                                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `@smthrs/platform-node`                  | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/src/index.ts)                       |
| `@smthrs/platform-node/NodeHost`         | [src/NodeHost.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/src/NodeHost.ts)                 |
| `@smthrs/platform-node/AtomicFileSystem` | [src/AtomicFileSystem.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/src/AtomicFileSystem.ts) |
| `@smthrs/platform-node/HostLiveness`     | [src/HostLiveness.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/src/HostLiveness.ts)         |
| `@smthrs/platform-node/ProcessReaper`    | [src/ProcessReaper.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/src/ProcessReaper.ts)       |
| `@smthrs/platform-node/ScopedProcess`    | [src/ScopedProcess.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/src/ScopedProcess.ts)       |

Every entry point is Node-only by construction: the bundle resolves
`node:child_process` and its siblings, and a build check keeps it that way. For a
browser host, use [`@smthrs/platform-browser`](/api/platform-browser); for Bun,
[`@smthrs/platform-bun`](/api/platform-bun).

## What a real composition adds

This package provides raw host services. A composition that enforces
capabilities wraps them in [`@smthrs/kernel`](/api/kernel)'s decorators, which
need a workspace root and a grant store. Add that package to your own
dependencies with the same workspace specifier, then compose:

```ts
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as HostServices from "@smthrs/kernel/HostServices"
import * as Workspace from "@smthrs/kernel/Workspace"
import { NodeHost } from "@smthrs/platform-node"
import * as Layer from "effect/Layer"

const guarded = HostServices.layer.pipe(
  Layer.provide(NodeHost.layer),
  Layer.provide(Workspace.layer("/absolute/workspace")),
  Layer.provide(GrantStore.layerNoop)
)
```

Turning on process containment adds a `ProcessLedger`, which the journal backs.
See [Contain child processes](./guides/contain-child-processes.md).

Most programs never compose this by hand. `@smthrs/flows`' `NodeRuntime` builds
the whole durable runtime, including `NodeHost.layerContainedAt` and
`HostLiveness.isAlive`, from one options object.
