---
title: "Run jj in a browser tab"
description: "Compose BrowserJj over a synchronous filesystem and the flows_jj wasm reactor, keep the mount durable, and know the six places the wasm backend answers differently from the CLI."
sidebar:
  order: 5
---

A tab cannot spawn the `jj` binary. It can run jj-lib itself: the library is
compiled to `wasm32-wasip1` and shipped in this package as
`wasm/flows_jj.wasm`, and `BrowserJj` runs it over a WASI preview 1 shim
written in this repository, on whatever synchronous filesystem the page mounts.
All eight contract operations work, with real change ids and a real operation
log.

## Compose the layer

```ts
import { Jj } from "@smthrs/jj"
import * as BrowserJj from "@smthrs/jj/browser/BrowserJj"
import { configureSingle, fs } from "@zenfs/core"
import { IndexedDB } from "@zenfs/dom"
import * as Effect from "effect/Effect"

await configureSingle({ backend: IndexedDB })

// wasmUrl: however your bundler serves this package's wasm/flows_jj.wasm.
const wasm = await WebAssembly.compileStreaming(fetch(wasmUrl))

const program = Effect.gen(function*() {
  const jj = yield* Jj
  return yield* jj.snapshot("before the step")
}).pipe(Effect.provide(BrowserJj.layer({ fs, wasm, root: "/repo" })))
```

Like the filesystem, the layer is a **function**: the page owns the mount and
the wasm bytes, so both arrive as arguments. The library never fetches, and it
never picks a storage backend for its host.

`BrowserJjOptions` takes five fields:

| Field      | Meaning                                                             |
| ---------- | ------------------------------------------------------------------- |
| `wasm`     | The reactor, precompiled or as raw bytes. Required.                 |
| `fs`       | The synchronous filesystem the repository lives on. Required.       |
| `root`     | The workspace root inside that namespace. Defaults to `"/"`.        |
| `onStdout` | Receives anything jj-lib writes to stdout. Unset drops it.          |
| `onStderr` | Receives anything jj-lib writes to stderr. Rust panics arrive here. |

Prefer a dedicated `root` such as `"/repo"` that already exists, so the
repository's `.jj` does not share the mount root with unrelated state.

### The options object is read once

`root`, `fs`, `onStdout`, and `onStderr` are read when `make` is called.
`wasm` is read later, at the first operation, which is what lets a page hand
over bytes it is still loading. Replacing a field on the options object
afterwards changes nothing, and raw bytes are copied at the read, so the
executable authority cannot be swapped between a failed operation and a retry.

`fs` itself stays a live service the page continues to own.

## Durability is the mount's job

ZenFS fronts OPFS or IndexedDB with a synchronous mirror and writes back
asynchronously. That mirror is precisely what lets jj-lib run without threads,
and it means an operation returning does not mean bytes reached storage. Call
your mount's `sync` after operations that must survive a reload. This layer
does not own the mount and never syncs for you.

## Hosts with no wasm module

```ts
import * as BrowserJj from "@smthrs/jj/browser/BrowserJj"

const layer = BrowserJj.layerUnsupported
```

Every operation reports `not_installed`, naming the jj command the CLI adapter
would have run. That is the same code the Node adapter reports for a missing
binary, so a caller needs no browser-specific branch. The service stays present:
an absent capability is a capability with an answer, never a missing tag.

## Where the wasm backend answers differently

These divergences are real, deliberate, and pinned by tests. Read them before
you assume parity with the CLI.

### Every operation auto-initializes the repository

If `root` has no `.jj`, the wasm layer creates one and continues. `NodeJj`
fails with `unknown` and jj's own "There is no jj repo" text. A mistyped `root`
in a page therefore yields a fresh empty repository, and a later `restore` of a
known change id reports `invalid_ref`, rather than a "no repo" error.

### Simple backend, no git

Repositories are created with jj's Simple backend, not the git backend, because
the git implementation is compiled out. There is no fetch, push, or clone, and
no colocated `.git`. Native jj can open these repositories. Upstream calls the
Simple backend a testing backend and does not promise on-disk format stability;
the pinned fork revision is what freezes the format for this package.

### A pinned lane is two calls

The frozen ABI has no revision field on `workspaceAdd`, so a pinned add is the
add followed by a restore rooted at the new lane. The whole sequence runs
uninterruptibly, because a cancel delivered between the two would strand a
registered lane.

If the pin fails, the adapter forgets the lane and reports the pin failure
against `workspaceAdd`, so the lane name is free again. As with any forget, the
lane directory stays on disk. If the **rollback itself** fails, the lane can
stay registered: the caller is told about the pin failure, which is the one it
can act on, and turning one error into two would hide it. Only a single ABI
operation can close that gap.

### `root(from)` answers for its own slice

The layer owns one workspace, so it answers the configured root for any path
inside it and fails for a path that is not. Answering for an unrelated tree
would be a wrong answer rather than a missing one. Containment is computed in
namespace coordinates, so `/repo/../outside` is correctly outside `/repo`.

### Symlinks degrade to regular files

jj-lib on `wasm32-wasip1` reports symlinks unsupported, the same posture as jj
on Windows without developer mode. Two consequences:

- Checking out a tree symlink materializes a regular file, not a link.
- Snapshotting a real on-disk symlink stores the **linked file's content** as
  the symlink target, because the library reads the path with a call that
  follows the link.

The degraded representation is stable: re-snapshotting reproduces an identical
tree entry, so state does not drift across further snapshot and restore cycles.

### Synchronous, single threaded, and our own output text

Each operation runs the wasm module to completion on the calling thread. There
is no incremental progress, and an interruption waits for the operation to
finish. A host that cares should put the Smithers runtime in a worker; this
layer does not do it for you. jj's parallel working-copy paths degrade to
serial execution, which is correct but not parallel.

`status` and `diff` are rendered by the `flows-jj` crate rather than by jj's
command-line interface. `diff` is git-format unified diff and `status` is a
concise change-id listing with A, M, and D markers. Both are stable and tested,
and neither is byte identical to what the CLI prints.

Finally, `not_installed` on this layer means "no wasm module". The wasm side
produces only `conflict`, `invalid_ref`, and `unknown`; `not_installed` comes
from `layerUnsupported` on the TypeScript side.

## The WASI shim is public too

`@smthrs/jj/browser/WasiPreview1` is exported, because it is testable without
any wasm module: `make` returns plain functions over memory, a filesystem, and
a file-descriptor table, so a test constructs a `WebAssembly.Memory`, calls the
syscalls directly, and asserts errno values.

Its `root` option confines the guest to one slice of the backing filesystem.
`..` of the namespace root is the root, and every symlink is resolved in
namespace coordinates rather than handed to the backend: an absolute target is
re-rooted at the preopen, a relative one is clamped against the link's own
directory, and intermediate components are resolved too, so a link naming a
directory cannot smuggle the rest of a path out of the slice. A chain that does
not terminate within the hop budget is `ELOOP`.

The filesystem it runs over is described structurally by
`@smthrs/jj/browser/WasiFs`, and the shape has two deliberate consequences:
`openSync` takes Node string flags (`"r"`, `"w"`, `"wx"`) rather than numeric
`O_*` constants, which are platform specific, and errors must be thrown with a
Node-style string `code` property so the shim can map them onto WASI errno
values. Both ZenFS and `node:fs` satisfy it already.

The shim's honest divergences from a kernel WASI host are listed in the
[API reference](../api.md).

## Rebuild the wasm artifact

```bash
pnpm run build:wasm
```

from this package. It drives `crates/flows-jj/build-wasm.mjs`, which runs a
release build for `wasm32-wasip1` and copies the result. Reproducible means per
host triple: cargo builds build scripts for the host, which puts the host
triple into every symbol hash, so the committed bytes are the
`x86_64-unknown-linux-gnu` build that CI reproduces. The script refuses to run
on another host and prints the container command that produces those bytes
anywhere.
