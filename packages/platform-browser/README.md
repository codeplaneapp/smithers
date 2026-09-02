# @smthrs/platform-browser

Browser implementations of Effect platform services backed by ZenFS and
just-bash, the two `@effect/platform-browser` does not ship.

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
behind `@smthrs/kernel`'s grant check. There is no Smithers wrapper around
`fetch`.

## Public API

| Export                                      | Meaning                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `BrowserFileSystem.make`                    | `FileSystem` over a ZenFS-shaped promises API, with no kernel claim attached.                                |
| `BrowserFileSystem.layer`                   | The same service, plus the attestation below.                                                                |
| `BrowserFileSystem.ZenFsPromisesLike`       | The structural slice of that API, so there is no `@zenfs/core` dependency.                                   |
| `BrowserChildProcessSpawner.make`, `.layer` | `ChildProcessSpawner` over a just-bash interpreter; `make` needs `FileSystem` and `Path` in context.         |
| `BrowserChildProcessSpawner.JustBashLike`   | The structural slice of that interpreter, so there is no `just-bash` dependency.                             |
| `BrowserServices.layer`                     | The aggregate: spawner, filesystem, and `Path`, mirroring `NodeServices.layer`.                              |
| `BrowserHost.layer`                         | The complete closed Host bundle: the above plus the wasm-backed `Jj` and Effect's fetch-backed `HttpClient`. |

**Composing `BrowserFileSystem.layer` is an assertion about `fs`.** The service
it provides carries `@smthrs/kernel`'s whole-filesystem isolation attestation,
which the kernel accepts on trust: it says the promises object cannot name any
path outside its own volume, so the guarded surface may resolve paths directly.
A mounted ZenFS volume satisfies that. A host-backed `node:fs/promises` does
not, so passing one is a test-time convenience for a process that is itself the
sandbox, never a production composition. `BrowserFileSystem.make` makes no such
claim.

Every backend is an **argument, not an import**. The page owns which ZenFS
backend is mounted (IndexedDB, OPFS, memory), which just-bash instance is wired
to it, and how the `flows_jj.wasm` bytes arrive (bundler asset, `fetch` plus
`WebAssembly.compileStreaming`; see `@smthrs/jj`'s README for the recipe).
`BrowserHost.layer({ bash, fs, jj })` takes all three; `jj.fs` is the
_synchronous_ slice of the same mount `fs` exposes as promises, because WASI
preview1 is a sync syscall ABI. All of them must view the same filesystem or
the spawner, the `FileSystem` service, and jj will disagree about what exists.
A page with no wasm to hand over composes `BrowserJj.layerUnsupported`
explicitly; the bundle never installs it silently. The signature says so:

```ts
import { BrowserServices } from "@smthrs/platform-browser"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"

const program = Effect.scoped(ChildProcess.make`ls -la`).pipe(
  Effect.provide(BrowserServices.layer({ bash, fs }))
)
```

Because the slices are structural, Node's own `node:fs/promises` satisfies
`ZenFsPromisesLike`, which is what the test suite runs the filesystem contract
against.

## What just-bash cannot do

The spawner is honest about the gap between an interpreter and a process table.
Each of these is documented on the module and covered by a test:

| Feature                        | Behaviour                                                                                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Streaming output               | Buffered. `stdout`/`stderr` emit one chunk each after the command finishes.                                                                                                                     |
| `all`                          | `stdout` then `stderr`, not a live interleaving, and it inherits both dispositions.                                                                                                             |
| `stdin`                        | A failing `Sink`; a command supplying a stdin `Stream` is rejected at spawn. just-bash accepts a string `stdin`; this adapter runs it once with captured output and has nowhere to stream into. |
| Interruption, timeouts, `kill` | Abort the interpreter through its `AbortSignal`. Every observable on the handle then reports a `PlatformError` naming the abort rather than interrupting the caller's fiber.                    |
| `killSignal`                   | Ignored: there is no process to signal in a tab.                                                                                                                                                |
| `forceKillAfter`               | Rejected on both routes it can arrive by: on the command, where Effect's `CommandOptions` extends `KillOptions`, and on `kill(options)`. There is no harder stop after the abort.               |
| Concurrency                    | One run at a time, behind a permit held until the interpreter promise settles, abort included.                                                                                                  |
| `pid`                          | A per-layer counter, not an OS pid. `unref` is a no-op.                                                                                                                                         |
| Process pipelines              | Rejected. Write the pipeline as one command line and let the interpreter parse.                                                                                                                 |
| `additionalFds`                | `Sink.drain` / `Stream.empty`, the answer Node gives for an unconfigured fd.                                                                                                                    |
| `extendEnv`                    | A request to the interpreter: just-bash merges `env` unless asked for `replaceEnv`, so the adapter asks for replacement whenever `env` is supplied and `extendEnv` is not `true`.               |
| `cwd`                          | Validated as a directory and resolved through `Path`. A tab has no `process.cwd()`, so pass an absolute virtual path.                                                                           |

Because the permit outlives the promise, an interpreter that ignores its
`AbortSignal` and never settles blocks every later run rather than being
abandoned with the mount half-written. `JustBashLike.exec` states that
requirement.

The `stdout`/`stderr` dispositions are _not_ in that table: `"inherit"` and
`"ignore"` yield an empty stream and a `Sink` is transduced through, exactly as
under `NodeChildProcessSpawner`. They are simply applied to captured text
rather than to a live readable.

## What ZenFS cannot do

`BrowserFileSystem` wires up only what a promises-shaped virtual filesystem can
serve. The slice has no writable file handle, no symlink creation, and no
watcher, so `chmod`, `chown`, `copy`, `copyFile`, `glob`, `link`, `symlink`,
`readLink`, `open`, `rename`, `sink`, `truncate`, `utimes`, `watch`, and the
`makeTemp*` family all fail with a `NotFound` `PlatformError` rather than
pretend. Each gap that turns out to matter becomes a ticket, not a
silently-wrong implementation.

What is served honours its options rather than dropping them:

| Operation                                    | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readDirectory({ recursive })`               | Walked here, since the slice has no recursive `readdir`. A symlinked directory is listed but not descended into when the backend can `lstat`, as under Node; a backend with only `stat` follows the link, and the walk refuses to revisit a directory it has already canonicalized. A 128-level ceiling applies only to a backend supplying neither `lstat` nor `realpath`, which can neither avoid a directory link nor recognize one it has already visited; a backend with either member is walked to whatever depth the tree has. |
| `access({ readable, writable })`             | Answered from the reported `mode` bits, since a mounted volume has no user identity. A path without the permission fails `PermissionDenied`.                                                                                                                                                                                                                                                                                                                                                                                          |
| `makeDirectory({ mode })`                    | Forwarded, so `0o700` is not created as `0o755`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `realPath`                                   | Canonicalized: symlinks are followed when the backend has `realpath`, and a `..` after a link names the parent of the link's target the way POSIX names it, rather than being collapsed lexically first. Without `realpath` the answer is lexical and a link resolves to its own name. The kernel's workspace boundary is only as strong as this, so a volume that can hold symlinks must supply `realpath`.                                                                                                                          |
| `writeFile({ flag, mode })`                  | Forwarded, so `"a"` appends and `"wx"` over an existing path fails `AlreadyExists`.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `exists`                                     | `false` only for an absent path; every other failure propagates rather than being reported as absence.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `stream({ offset, bytesToRead, chunkSize })` | Honoured, and refused when they are not whole byte counts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Bytes and names cross the backend boundary by value. `writeFile` copies
`data` and reads `flag` and `mode` when it is called, so the effect it returns
describes one write however the caller's buffer or options change before it
runs or between retries, and however long the backend holds the bytes it was
handed. `readFile` and `readDirectory` return a buffer and an array the caller
owns: writing into them does not reach a backend that answers from its own
storage, and a later change in that storage does not reach a result already
returned. `stream` chunks are fresh allocations for the same reason, and
`writeFileString` encodes at run time because a string cannot change under the
caller.

A tab has no working directory, so a relative path given to `realPath` resolves
against the volume root.

Strings are UTF-8 through the standard `TextDecoder` and `TextEncoder`; an
encoding `TextDecoder` does not know fails as `BadArgument`, invalid byte
sequences decode to the replacement character, and paths are not
Unicode-normalized. `stream` allocates 64 KiB per chunk by default and at most
64 MiB when a caller names a size. Captured interpreter output is not bounded:
the complete `stdout` and `stderr` strings are held and re-encoded, so bound the
command rather than expecting the adapter to.

Everything here bundles for the browser; `pnpm run browser` at the repository
root pins that property.
