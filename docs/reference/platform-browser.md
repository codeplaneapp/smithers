# `@smthrs/platform-browser`

This page is the public API reference for the browser implementations of two
`effect` platform services: `FileSystem` and `ChildProcessSpawner`.

`effect`'s own browser platform package covers HTTP, sockets, workers,
key-value storage, and crypto. It ships neither of these, because a tab has no
`node:fs` and cannot fork. A tab *can* have both, given a virtual filesystem
mounted over IndexedDB, OPFS, or memory (ZenFS) and an in-page bash interpreter
(just-bash). This package adapts those two onto the effect contracts the way
`platform-node` adapts `node:fs` and `node:child_process`.

The package depends on `effect` alone. Neither `@zenfs/core` nor `just-bash` is
a dependency: both are taken as **structural slices**, so the page decides which
backend is mounted and this package never pins one.

## Modules

| Import | Exports |
| --- | --- |
| `@smthrs/platform-browser` | the three namespaces below |
| `@smthrs/platform-browser/BrowserFileSystem` | `ZenFsPromisesLike`, `ZenFsFileHandleLike`, `ZenFsStatsLike`, `make`, `layer` |
| `@smthrs/platform-browser/BrowserChildProcessSpawner` | `JustBashLike`, `layer` |
| `@smthrs/platform-browser/BrowserServices` | `BrowserServices`, `layer` |

```ts
import { BrowserServices } from "@smthrs/platform-browser"
```

## The layers are functions

`NodeServices.layer` is a value; `BrowserServices.layer` is a function of
`{ bash, fs }`. That is not an ergonomic accident. A tab owns which ZenFS
backend is mounted and when, and the just-bash instance must be wired to the
*same* filesystem — otherwise the spawner and the `FileSystem` service disagree
about what exists, and a command writes into a filesystem no reader can see. The
signature makes the pairing the caller's explicit decision.

Because the slices are structural, Node's own `node:fs/promises` satisfies
`ZenFsPromisesLike`. That is what the test suite runs the filesystem contract
against, so the adapter is exercised against a real directory rather than a
double.

## FileSystem coverage

`BrowserFileSystem.make` wires up `readFile`, `readFileString`, `writeFile`,
`writeFileString`, `stream`, `makeDirectory`, `readDirectory`, `stat`,
`realPath`, `remove`, `access`, and `exists`. Everything else keeps
`FileSystem.makeNoop`'s behaviour — a `NotFound` failure. That is the honest
answer for a backend with no symlinks, writable handles, or watchers: `chmod`,
`chown`, `copy`, `copyFile`, `glob`, `link`, `symlink`, `readLink`, `open`,
`rename`, `sink`, `truncate`, `utimes`, `watch`, and the `makeTemp*` family fail
rather than pretend to have succeeded. `sink` is in that list because the slice
has no writable file handle to append through, so its incremental contract
cannot be honoured. Each gap that turns out to matter becomes a ticket, not a
silently-wrong implementation.

Three of those wirings exist because `makeNoop` is not `make`: it hardcodes
`readFileString`, `writeFileString`, and `exists` rather than deriving them from
`readFile`, `writeFile`, and `access`, so leaving them alone would fail on files
that plainly exist.

`stream` reads bounded chunks through a file handle rather than loading the
whole file, honouring `offset`, `bytesToRead`, and `chunkSize`. `writeFile`
forwards `flag` and `mode` to the backend rather than dropping them, so
`{ flag: "a" }` appends instead of silently truncating. Thrown backend errors
are mapped onto `PlatformError`: `ENOENT` becomes `NotFound` and `EEXIST`
becomes `AlreadyExists`, because `exists` and every `catchTag` in effect's own
`make` branch on those.

## ChildProcessSpawner divergences

just-bash is a buffered, run-to-completion API with no process table. The
spawner is built from `ChildProcessSpawner.make(spawn)`, so `exitCode`,
`string`, `lines`, `streamString`, and `streamLines` are all derived from the
one `spawn` — and all inherit the same divergences, each documented on the
module and covered by a test:

| Feature | Behaviour |
| --- | --- |
| Streaming output | buffered; `stdout` and `stderr` each emit at most one chunk after the command finishes |
| `all` | `stdout` followed by `stderr`, not a live interleaving |
| `isRunning` | always `false` by the time a caller can observe it |
| `stdin` | a failing `Sink`; a command supplying a stdin `Stream` is rejected at spawn time |
| `kill`, signals | fails — there is no signal to deliver to an interpreter call |
| Interruption, timeouts | the call is serialized and uninterruptible, so both wait for the interpreter to finish before they report |
| `pid` | a per-layer counter, not an OS pid; `unref` is a no-op |
| Process pipelines | a `PipedCommand` is rejected; express the pipeline as one command line |
| `additionalFds` | `Sink.drain` / `Stream.empty`, the answer `NodeChildProcessSpawner` gives for an unconfigured descriptor |
| `extendEnv` | ignored — a tab has no ambient process environment to extend |
| `stdout`/`stderr` dispositions | kept at their Node meaning: `"inherit"` and `"ignore"` yield an empty stream, a `Sink` is transduced through, even though the interpreter captured the text either way |

Runs are serialized behind a semaphore and executed inside an uninterruptible
boundary because just-bash cannot abort an in-flight call. Interruption is still
scope closure and fiber interruption, never an `AbortSignal`; it simply cannot
take effect until the interpreter returns, and a caller never observes
completion while hidden mutation of the virtual filesystem is still running.

A `StandardCommand` is rendered to a command line before it reaches the
interpreter. Without `shell`, the command and its arguments are POSIX
single-quoted so a spawn keeps argv semantics; with `shell`, they are joined
verbatim, mirroring how Node hands `sh -c` an unquoted line. `cwd` is validated
through the `FileSystem` service and resolved through `Path` before anything
runs, which is why the layer requires both.

## Browser support

`@smthrs/platform-browser` is gated as a browser entry point by
`scripts/browser-check.mjs` (`pnpm run browser`, and one CI step). Nothing in the
package resolves a `node:` built-in.

See [browser support](../architecture/browser-support.md), the
[`@smthrs/kernel` reference](kernel.md) — whose closed list this package's `BrowserHost` bundle composes
`BrowserFileSystem` — and [Hosts and capabilities](../concepts/hosts-and-capabilities.md).
