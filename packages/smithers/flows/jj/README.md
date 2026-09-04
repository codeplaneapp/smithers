# @smthrs/jj

**Documentation:** https://jj.smithers.sh

Jujutsu version control as a portable Effect host service. Smithers snapshots the
working copy around every step, so jj is host access: it goes through a layer
like the filesystem does, not through an ad-hoc `spawn`.

```sh
pnpm add @smthrs/jj
```

The complete API reference, including every export and every signature, is at
<https://jj.smithers.sh/reference/api/>. This file is the overview.

## Entry points

The root is **platform-neutral and browser-bundleable**: the contract, its
error, and the no-op layer only. Every implementation lives under an explicit
subpath, the way `effect` keeps `@effect/platform-node` out of `effect`, so
importing the contract never resolves a `node:` built-in. `package.json` exports
`./*` over `src/`, so every module below is public.

| Import                            | Platform                                                   |
| --------------------------------- | ---------------------------------------------------------- |
| `@smthrs/jj`                      | any: contract only; bundles for the browser                |
| `@smthrs/jj/browser/BrowserJj`    | browser: jj-lib compiled to WASM over a virtual FS         |
| `@smthrs/jj/browser/WasiPreview1` | browser: the WASI preview 1 shim that module runs on       |
| `@smthrs/jj/browser/WasiFs`       | browser: the synchronous filesystem surface the shim needs |
| `@smthrs/jj/node/NodeJj`          | Node (`node:child_process`)                                |
| `@smthrs/jj/node/resolveJjBinary` | Node: which `jj` file this host spawns, and why            |
| `@smthrs/jj/bun/BunJj`            | Bun, reusing the Node adapter                              |

`pnpm run browser` at the repository root pins the bundleability of that table.

## Public API

| Export                                                  | Meaning                                                                                      |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `Jj`                                                    | The service interface and its tag (`@smthrs/jj/Jj`), including optional `root` and `revert`. |
| `ChangeId`                                              | The durable handle a run uses to name workspace state.                                       |
| `JjErrorCode`, `JjError`, `jjError`, `isJjError`        | The closed failure vocabulary, its constructor, and its refinement.                          |
| `JjErrorCause`, `jjErrorCause`, `causeMessageLimit`     | The journal-safe projection of an underlying host failure, and its bound.                    |
| `JjFailure`                                             | The full error channel: jj's own failure plus the three the capability kernel adds.          |
| `make`, `makeNoop`, `layerNoop`                         | Complete, stubbed, and layered service construction.                                         |
| `NodeJj.layer`, `BunJj.layer`                           | The jj CLI, spawned with argv and never a shell string.                                      |
| `NodeJj.layerAt`, `BunJj.layerAt`                       | The same, bound to one absolute repository root.                                             |
| `NodeJj.layerSpawner`, `BunJj.layerSpawner`             | The same commands through the host's `ChildProcessSpawner`, so a contained host contains jj. |
| `NodeJj.layerSpawnerAt`, `BunJj.layerSpawnerAt`         | Repository-bound and spawner-routed together.                                                |
| `resolveJjBinary`, `describe`, `overrideVariables`, ... | Which `jj` file this host spawns, and the guidance `smthrs doctor` prints.                   |
| `BrowserJj.make`, `BrowserJj.layer`, `BrowserJjOptions` | jj-lib compiled to `wasm32-wasip1`, run over a virtual filesystem.                           |
| `BrowserJj.layerUnsupported`                            | The fallback for hosts that ship no wasm module; fails `not_installed`.                      |
| `WasiPreview1.make`, `Errno`, `WasiExitError`           | The WASI preview 1 shim the browser layer instantiates the module against.                   |

`root` and `revert` are optional **on the interface**, so a hand-written test
double may leave them out. Every layer this package ships defines both. `root`
answers the repository root that contains a path with `jj root`, which is right
for colocated repositories and workspaces where walking up looking for `.jj` is
not. `revert` undoes one change and reports the paths it touched, which
`restore` cannot do: restoring moves the working copy back to a point and
discards everything after it, while a revert keeps the rest of the history.

**Feature detection is by error code, never by property absence.** A backend
that cannot perform an operation keeps the method and answers `not_installed` in
the error channel, so `"revert" in jj` tells a caller nothing and the code that
comes back tells it everything. An absent capability is a capability with an
answer.

```ts
import { Jj } from "@smthrs/jj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const jj = yield* Jj
  return yield* jj.snapshot("before the step")
}).pipe(Effect.provide(NodeJj.layer))

Effect.runPromise(program)
```

`snapshot(message)` describes the current change with that message and then
opens a fresh one. With no message it takes the snapshot and leaves the
description alone: it runs no `jj describe` at all, because `jj describe`
without `-m` starts `$JJ_EDITOR` and waits for it, and because `-m ""` would
erase a description the caller never asked to change. The change id still
comes back, since every jj command snapshots the working copy first.
[NodeJj.test.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/jj/test/NodeJj.test.ts)
pins that with a marker editor on `JJ_EDITOR`.

`SMITHERS_JJ_PATH` names the `jj` binary the Node and Bun layers spawn. An
override that names an existing file stays authoritative even when it cannot be
executed, so a broken explicit path is reported rather than a different binary
being quietly substituted. An override that names nothing falls through to
`PATH`, and `smthrs doctor` says so. This package vendors no `jj` binaries.

One invocation buffers at most **64 MiB of each output stream**, counted in
bytes as they arrive rather than in decoded characters. jj is not an attacker,
but the engine outlives any one command, so a child that never stops printing is
killed and the operation fails with `unknown` rather than filling a buffer
nobody will read. Both Node layers apply the same ceiling, since routing jj
through the host's spawner must not change what a caller observes.

The tag key and the error `_tag` are durable identity: step keys digest the
resolved service set and `JjError` round-trips through the journal, so
renaming either invalidates recorded runs. `cause` is a projection onto plain
data for the same reason: an `Error` serializes to `{}`.

## Browser

A tab cannot spawn the `jj` binary. What it can do is run **jj-lib itself**,
the real one, pinned to a fork revision as a cargo git dependency, compiled to
`wasm32-wasip1` and fed a filesystem. `BrowserJj.layer` does exactly that: a
small Rust crate (`crates/flows-jj`) exposes the `Jj` contract operations from
jj-lib, and a hand-written WASI preview 1 shim in this package routes every
filesystem syscall to the same virtual-FS slice `BrowserFileSystem` is mounted
on (ZenFS in production, `node:fs` in tests). `snapshot`, `restore`, `diff`,
`workspaceAdd`, `workspaceForget`, and `status` all work: real change ids, a
real op log, repos that survive a reload.

Like `BrowserFileSystem`, the layer is a **function**: the page owns the
filesystem mount and the wasm bytes, so both arrive as arguments. The library
never fetches; hand it a compiled `WebAssembly.Module` or the raw bytes.

```ts
import { Jj } from "@smthrs/jj"
import * as BrowserJj from "@smthrs/jj/browser/BrowserJj"
import { configureSingle, fs } from "@zenfs/core"
import { IndexedDB } from "@zenfs/dom"
import { Effect } from "effect"

await configureSingle({ backend: IndexedDB })
// wasmUrl: however your bundler serves this package's wasm/flows_jj.wasm
const wasm = await WebAssembly.compileStreaming(fetch(wasmUrl))

const program = Effect.gen(function*() {
  const jj = yield* Jj
  return yield* jj.snapshot("before the step")
}).pipe(Effect.provide(BrowserJj.layer({ fs, wasm })))
```

The wasm artifact ships in the package at `wasm/flows_jj.wasm`; how it becomes
a URL is the bundler's business (Vite: `?url` import, or copy it as an asset).
It is rebuilt reproducibly with `pnpm run build:wasm` in this package, which
drives `crates/flows-jj/build-wasm.mjs` (`cargo build --release --target
wasm32-wasip1` plus a copy). Reproducible means per host triple: cargo builds
build scripts for the host, which puts the host triple into every symbol
hash, so the committed bytes are the `x86_64-unknown-linux-gnu` build that CI
reproduces. The script refuses to run on another host and prints the
container command that produces those bytes anywhere.

`BrowserJjOptions` is read once. `root`, `fs`, `onStdout`, and `onStderr` are
taken when `make` is called; `wasm` is taken at the first operation, which is
what lets a page hand over bytes it is still loading. Replacing a field on the
options object afterwards changes nothing.

**Durability is the mount's job, not this layer's.** ZenFS fronts OPFS or
IndexedDB with a synchronous mirror and writes back asynchronously. That sync
mirror is precisely what lets jj-lib run without threads, but it means an op
returning does not mean bytes hit disk. Call `fs.sync()` (or your mount's
equivalent) after jj operations before assuming reload-survival. The layer
does not own the mount and never syncs for you.

**The divergences from `NodeJj` are real and are not hidden:**

- **Simple backend, no git.** Repos are created with jj's Simple backend
  (`Workspace::init_simple`), not the git backend, because `gix` is compiled
  out. There is no fetch/push/clone and no colocated `.git`; browser git
  interop needs a `fetch()`-based smart-HTTP client, which rc.0 does not ship.
  Native jj _can_ open these repos (`jj debug init-simple` creates the same
  shape). Upstream calls the Simple backend a testing backend and does not
  promise on-disk format stability; the pinned jj fork rev is what freezes the
  format.
- **Auto-init.** Every operation initializes a repo at the workspace root if
  none exists. `NodeJj` fails in a directory that is not a workspace, so a
  mistyped `root` here yields a fresh empty repo rather than a "no repo" error.
- **A pinned `workspaceAdd` is two calls.** The frozen ABI has no revision
  field, so a revisioned add is the add followed by a restore rooted at the new
  lane. The whole sequence runs uninterruptibly. If the restore fails, the add
  is rolled back with a `workspaceForget` and the failure is reported against
  `workspaceAdd`, so the lane name is free again and no workspace stays
  registered at a tree that was never pinned. As with any forget, the lane
  directory itself is left on disk. If the rollback ITSELF fails, the lane does
  stay registered: the caller is told about the pin failure, which is the one it
  can act on, and only a single ABI operation can make the pair atomic.
- **`root(from)` answers for its own slice.** The layer owns one workspace, so
  it answers the configured root for any path inside it and fails for a path
  that is not, rather than answering for an unrelated tree.
- **Symlinks degrade to regular files.** jj-lib on `wasm32-wasip1` reports
  symlinks unsupported, so checkout materializes a tree symlink as a regular
  file, and snapshotting a real on-disk symlink stores the linked file's
  content as the target. The representation is stable across further
  snapshot/restore cycles.
- **Synchronous and on the calling thread.** Each operation runs the wasm to
  completion: no incremental progress, and interruption waits for the op to
  finish, the same posture as `BrowserChildProcessSpawner`. Hosts that care
  should put the Smithers runtime in a Worker; this layer does not do it for
  them.
- **Single-threaded.** jj's rayon-parallel working-copy paths degrade to
  serial execution on threadless wasm. Correct, just not parallel.
- **The output text is ours.** `status` and `diff` are rendered by the
  `flows-jj` crate, not by jj-cli: `diff` is git-format unified diff, and
  `status` is a concise change-id + A/M/D listing. Both are stable and
  tested, but not byte-identical to what the CLI prints.
- **`not_installed` means "no wasm module".** The wasm side only produces
  `conflict`, `invalid_ref`, and `unknown`; `not_installed` comes from the TS
  side, from `layerUnsupported`, kept exported for hosts that ship no module.

See the [kernel reference](https://kernel.smithers.sh/reference/api/), which
owns the closed host service list this contract is one slot of.
