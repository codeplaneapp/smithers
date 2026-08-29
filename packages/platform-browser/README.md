# @smthrs/platform-browser

Browser implementations of Effect platform services backed by ZenFS and
just-bash — the two `@effect/platform-browser` does not ship.

```sh
pnpm add @smthrs/platform-browser
```

`effect`'s own browser platform package covers HTTP, sockets, workers,
key-value storage, and crypto. It ships neither a `FileSystem` nor a
`ChildProcessSpawner`, because a tab has no `node:fs` and cannot fork. A tab
_can_ have both, given a virtual filesystem and an in-page bash interpreter.
This package is that adapter pair, written the way `platform-node` writes its
own.

Network access is not one of them: `BrowserHost.layer` provides Effect's own
`FetchHttpClient.layer` directly, configured with
`RequestInit { redirect: "manual" }` so the runtime never follows a redirect
behind `@smthrs/kernel`'s grant check. There is no `flows` wrapper around
`fetch`.

## Public API

| Export                                    | Meaning                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `BrowserFileSystem.make`, `.layer`        | `FileSystem` over a ZenFS-shaped promises API.                                                               |
| `BrowserFileSystem.ZenFsPromisesLike`     | The structural slice of that API — no `@zenfs/core` dependency.                                              |
| `BrowserChildProcessSpawner.layer`        | `ChildProcessSpawner` over a just-bash interpreter.                                                          |
| `BrowserChildProcessSpawner.JustBashLike` | The structural slice of that interpreter — no `just-bash` dependency.                                        |
| `BrowserServices.layer`                   | The aggregate: spawner, filesystem, and `Path`, mirroring `NodeServices.layer`.                              |
| `BrowserHost.layer`                       | The complete closed Host bundle: the above plus the wasm-backed `Jj` and Effect's fetch-backed `HttpClient`. |

Every backend is an **argument, not an import**. The page owns which ZenFS
backend is mounted (IndexedDB, OPFS, memory), which just-bash instance is wired
to it, and how the `flows_jj.wasm` bytes arrive (bundler asset, `fetch` +
`WebAssembly.compileStreaming` — see `@smthrs/jj`'s README for the recipe).
`BrowserHost.layer({ bash, fs, jj })` takes all three; `jj.fs` is the
_synchronous_ slice of the same mount `fs` exposes as promises, because WASI
preview1 is a sync syscall ABI. All of them must view the same filesystem or
the spawner, the `FileSystem` service, and jj will disagree about what exists.
A page with no wasm to hand over composes `BrowserJj.layerUnsupported`
explicitly — the bundle never installs it silently. The signature says so:

```ts
import { BrowserServices } from "@smthrs/platform-browser"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"

const program = Effect.scoped(ChildProcess.make`ls -la`).pipe(
  Effect.provide(BrowserServices.layer({ bash, fs }))
)
```

Because the slices are structural, Node's own `node:fs/promises` satisfies
`ZenFsPromisesLike` — which is what the test suite runs the filesystem contract
against.

## What just-bash cannot do

The spawner is honest about the gap between an interpreter and a process table.
Each of these is documented on the module and covered by a test:

| Feature                | Behaviour                                                                        |
| ---------------------- | -------------------------------------------------------------------------------- |
| Streaming output       | Buffered. `stdout`/`stderr` emit one chunk each after the command finishes.      |
| `all`                  | `stdout` then `stderr`, not a live interleaving.                                 |
| `stdin`                | A failing `Sink`; a command supplying a stdin `Stream` is rejected at spawn.     |
| `kill`, signals        | Fails — there is nothing to signal. Interruption waits for the boundary instead. |
| Interruption, timeouts | Wait for the interpreter to finish; the run is uninterruptible and serialized.   |
| `pid`                  | A per-layer counter, not an OS pid. `unref` is a no-op.                          |
| Process pipelines      | Rejected. Write the pipeline as one command line and let the interpreter parse.  |
| `additionalFds`        | `Sink.drain` / `Stream.empty`, the answer Node gives for an unconfigured fd.     |
| `extendEnv`            | Ignored — there is no ambient process environment in a tab.                      |

The `stdout`/`stderr` dispositions are _not_ in that table: `"inherit"` and
`"ignore"` yield an empty stream and a `Sink` is transduced through, exactly as
under `NodeChildProcessSpawner`. They are simply applied to captured text
rather than to a live readable.

## What ZenFS cannot do

`BrowserFileSystem` wires up only what a promises-shaped virtual filesystem can
serve. The slice has no writable file handle, no symlinks, and no watcher, so
`chmod`, `chown`, `copy`, `copyFile`, `glob`, `link`, `symlink`, `readLink`,
`open`, `rename`, `sink`, `truncate`, `utimes`, `watch`, and the `makeTemp*`
family all fail with a `NotFound` `PlatformError` rather than pretend. Each gap
that turns out to matter becomes a ticket, not a silently-wrong implementation.

Everything else behaves as `NodeFileSystem` does, including `flag` on
`writeFile`/`writeFileString` — an `"a"` appends rather than truncating, and a
`"wx"` over an existing path fails as `AlreadyExists`.

Everything here bundles for the browser; `pnpm run browser` at the repository
root pins that property.
