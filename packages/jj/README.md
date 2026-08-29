# @smthrs/jj

Jujutsu version control as a portable Effect host service. `flows` snapshots the
working copy around every step, so jj is host access — it goes through a layer
like the filesystem does, not through an ad-hoc `spawn`.

```sh
pnpm add @smthrs/jj
```

## Entry points

The root is **platform-neutral and browser-bundleable**: the contract, its
error, and the no-op layer only. Every implementation lives under an explicit
subpath, the way `effect` keeps `@effect/platform-node` out of `effect`, so
importing the contract never resolves a `node:` built-in.

| Import                         | Platform                                            |
| ------------------------------ | --------------------------------------------------- |
| `@smthrs/jj`                   | any — contract only; bundles for the browser        |
| `@smthrs/jj/browser/BrowserJj` | browser — jj-lib compiled to WASM over a virtual FS |
| `@smthrs/jj/node/NodeJj`       | Node (`node:child_process`)                         |
| `@smthrs/jj/bun/BunJj`         | Bun, reusing the Node adapter                       |

`pnpm run browser` at the repository root pins that table.

## Public API

| Export                              | Meaning                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `Jj`                                | The service interface and its tag (`@smthrs/jj/Jj`).                     |
| `ChangeId`                          | The durable handle a run uses to name workspace state.                   |
| `JjErrorCode`, `JjError`, `jjError` | The closed failure vocabulary and its constructor.                       |
| `make`, `makeNoop`, `layerNoop`     | Complete, stubbed, and layered service construction.                     |
| `NodeJj.layer`, `BunJj.layer`       | The jj CLI, spawned with argv and never a shell string.                  |
| `BrowserJj.layer`                   | jj-lib compiled to `wasm32-wasip1`, run over a virtual filesystem.       |
| `BrowserJj.layerUnsupported`        | The fallback for hosts that ship no wasm module — fails `not_installed`. |

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

The tag key and the error `_tag` are durable identity: step keys digest the
resolved service set and `JjError` round-trips through the journal, so
renaming either invalidates recorded runs.

## Browser

A tab cannot spawn the `jj` binary. What it can do is run **jj-lib itself** —
the real one, pinned at v0.44.0 via the `vendor/jj` submodule — compiled to
`wasm32-wasip1` and fed a filesystem. `BrowserJj.layer` does exactly that: a
small Rust crate (`crates/flows-jj`) exposes the six `Jj` contract operations
from jj-lib, and a hand-written WASI preview1 shim in this package routes
every filesystem syscall to the same virtual-FS slice `BrowserFileSystem` is
mounted on (ZenFS in production, `node:fs` in tests). All six operations work:
`snapshot`, `restore`, `diff`, `workspaceAdd`, `workspaceForget`, `status` —
real change ids, a real op log, repos that survive a reload.

Like `BrowserFileSystem`, the layer is a **function**: the page owns the
filesystem mount and the wasm bytes, so both arrive as arguments. The library
never fetches — hand it a compiled `WebAssembly.Module` or the raw bytes.

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
wasm32-wasip1` + copy). Reproducible means per host triple: cargo builds
build scripts for the host, which puts the host triple into every symbol
hash, so the committed bytes are the `x86_64-unknown-linux-gnu` build that CI
reproduces. The script refuses to run on another host and prints the
container command that produces those bytes anywhere.

**Durability is the mount's job, not this layer's.** ZenFS fronts OPFS or
IndexedDB with a synchronous mirror and writes back asynchronously — that sync
mirror is precisely what lets jj-lib run without threads, but it means an op
returning does not mean bytes hit disk. Call `fs.sync()` (or your mount's
equivalent) after jj operations before assuming reload-survival. The layer
does not own the mount and never syncs for you.

**The divergences from `NodeJj` are real and are not hidden:**

- **Simple backend, no git.** Repos are created with jj's Simple backend
  (`Workspace::init_simple`), not the git backend — `gix` is compiled out.
  There is no fetch/push/clone and no colocated `.git`; browser git interop
  needs a `fetch()`-based smart-HTTP client and is a separate ticket. Native
  jj _can_ open these repos (`jj debug init-simple` creates the same shape).
  Upstream calls the Simple backend a testing backend and does not promise
  on-disk format stability; the `vendor/jj` pin is what freezes the format.
- **Auto-init.** `snapshot` initializes a repo at the workspace root if none
  exists. `NodeJj` fails in a directory that is not a workspace.
- **Synchronous and on the calling thread.** Each operation runs the wasm to
  completion — no incremental progress, and interruption waits for the op to
  finish, the same posture as `BrowserChildProcessSpawner`. Hosts that care
  should put the flows runtime in a Worker; this layer does not do it for
  them.
- **Single-threaded.** jj's rayon-parallel working-copy paths degrade to
  serial execution on threadless wasm. Correct, just not parallel.
- **The output text is ours.** `status` and `diff` are rendered by the
  `flows-jj` crate, not by jj-cli — `diff` is git-format unified diff, and
  `status` is a concise change-id + A/M/D listing. Both are stable and
  tested, but not byte-identical to what the CLI prints.
- **`not_installed` now means "no wasm module".** The wasm side only produces
  `conflict`, `invalid_ref`, and `unknown`; `not_installed` comes from the TS
  side — `layerUnsupported`, kept exported for hosts that ship no module.

See the [kernel reference](../../docs/reference/kernel.md), which owns the closed
host service list this contract is one slot of.
