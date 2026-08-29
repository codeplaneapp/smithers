---
description: "The two Effect platform services a tab lacks: a FileSystem over ZenFS and a ChildProcessSpawner over just-bash."
---

# @smthrs/platform-browser

The two Effect platform services `@effect/platform-browser` does not ship. Its browser platform package covers HTTP, sockets, workers, key-value storage, and crypto, but a tab has no `node:fs` and cannot fork, so it ships neither a `FileSystem` nor a `ChildProcessSpawner`. A tab *can* have both, given a virtual filesystem (ZenFS) and an in-page bash interpreter (just-bash). This package is that adapter pair.

```ts
import { BrowserServices } from "@smthrs/platform-browser"
import * as Effect from "effect/Effect"
import { ChildProcess } from "effect/unstable/process"

const makeProgram = (options: Parameters<typeof BrowserServices.layer>[0]) =>
  Effect.scoped(ChildProcess.make`ls -la`).pipe(
    Effect.provide(BrowserServices.layer(options))
  )
```

Both backends are arguments, not imports: neither `@zenfs/core` nor `just-bash` is a dependency here. The page owns which ZenFS backend is mounted (IndexedDB, OPFS, memory) and which just-bash instance is wired to it. The signature says so. The package depends on `effect` alone.

:::danger
The filesystem behind `fs` and the one behind `bash` must be the *same* filesystem, or the spawner and the `FileSystem` service will disagree about what exists.
:::

## Entry points

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/platform-browser` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/platform-browser/src/index.ts) | any |
| `@smthrs/platform-browser/BrowserFileSystem` | [src/BrowserFileSystem.ts](https://github.com/smithersai/flows/blob/main/packages/platform-browser/src/BrowserFileSystem.ts) | any |
| `@smthrs/platform-browser/BrowserChildProcessSpawner` | [src/BrowserChildProcessSpawner.ts](https://github.com/smithersai/flows/blob/main/packages/platform-browser/src/BrowserChildProcessSpawner.ts) | any |
| `@smthrs/platform-browser/BrowserServices` | [src/BrowserServices.ts](https://github.com/smithersai/flows/blob/main/packages/platform-browser/src/BrowserServices.ts) | any |

Every module is browser-bundleable; the root barrel is one of the entry points `scripts/browser-check.mjs` executes.

## Namespaces

| Export | Kind | Notes |
| --- | --- | --- |
| `BrowserFileSystem.ZenFsPromisesLike` | interface | the structural slice of a ZenFS `fs.promises`; Node's own `node:fs/promises` satisfies it |
| `BrowserFileSystem.ZenFsFileHandleLike`, `ZenFsStatsLike` | interfaces | the bounded-read handle and the `Stats` subset `stat` needs |
| `BrowserFileSystem.make`, `BrowserFileSystem.layer` | constructor + layer | effect's `FileSystem` over that slice |
| `BrowserChildProcessSpawner.JustBashLike` | interface | the structural slice of a just-bash interpreter: one `run(command, { cwd, env })` |
| `BrowserChildProcessSpawner.layer` | layer | effect's `ChildProcessSpawner` over that interpreter; requires `FileSystem` and `Path` |
| `BrowserServices.BrowserServices` | type | `ChildProcessSpawner \| FileSystem \| Path` |
| `BrowserServices.layer` | layer | the aggregate, mirroring `NodeServices.layer`; a function, because the page owns both backends |

## What the filesystem serves

Only the operations a browser backend can actually serve are wired up: `readFile`, `readFileString`, `writeFile`, `writeFileString`, `stream`, `makeDirectory`, `readDirectory`, `stat`, `realPath`, `remove`, `access`, and `exists`. Everything else keeps `FileSystem.makeNoop`'s behaviour, a `NotFound` failure, which is the honest answer for a backend with no symlinks, writable handles, or watchers: `chmod`, `chown`, `copy`, `copyFile`, `glob`, `link`, `symlink`, `readLink`, `open`, `rename`, `sink`, `truncate`, `utimes`, `watch`, and the `makeTemp*` family fail rather than pretend. Reads use bounded file-handle chunks rather than loading the whole file, and `writeFile`'s `flag` and `mode` are forwarded to the backend, so `{ flag: "a" }` appends rather than silently truncating. Each gap that turns out to matter becomes a ticket, not a silently-wrong implementation.

`readFileString`, `writeFileString`, and `exists` are wired explicitly because `makeNoop`, unlike `make`, does not derive them from `readFile`/`writeFile`/`access`. It hardcodes them, which would fail on files that plainly exist.

## What just-bash cannot do

just-bash is a buffered, run-to-completion API with no process table. The spawner does not hide the gap; every row is documented on the module and covered by a test.

| Feature | Behaviour |
| --- | --- |
| Streaming output | buffered; `stdout` and `stderr` each emit at most one chunk, after the command finishes |
| `all` | `stdout` then `stderr`, not a live interleaving; `isRunning` is always `false` by the time a caller can observe it |
| `stdin` | a failing `Sink`; a command supplying a stdin `Stream` is rejected at spawn rather than losing its input silently |
| `kill`, signals | fails; there is no signal to deliver |
| Interruption, timeouts | the interpreter call is serialized and uninterruptible, so both wait for it to finish before they report |
| `pid` | a per-layer counter, not an OS pid; `unref` is a no-op |
| Process pipelines | a `PipedCommand` is rejected; write the pipeline as one command line and let the interpreter parse the `\|` |
| `additionalFds` | `Sink.drain` / `Stream.empty`, the answer `NodeChildProcessSpawner` gives for an unconfigured descriptor |
| `extendEnv` | ignored; there is no ambient process environment in a tab |
| `stdout`/`stderr` dispositions | kept at their Node meaning: `"inherit"` and `"ignore"` yield an empty stream, a `Sink` is transduced through |

A `StandardCommand` is rendered to a command line: without `shell`, the command and its arguments are POSIX single-quoted so a spawn keeps argv semantics; with `shell`, they are joined verbatim, mirroring how Node hands `sh -c` an unquoted line.

## Reading next

This package composes `BrowserFileSystem` and `BrowserChildProcessSpawner` into its own `BrowserHost` bundle, and [browser support](/architecture) states which entry points the gate executes.
