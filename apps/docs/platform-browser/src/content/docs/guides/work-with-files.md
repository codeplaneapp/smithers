---
title: "Read and write files on a mounted volume"
description: "Which FileSystem operations a ZenFS-shaped volume serves, which options are honoured rather than dropped, how backend errors are tagged, and what the fifteen refused operations do instead."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-browser/docs/guides/work-with-files.md"
---

`BrowserFileSystem` implements Effect's `FileSystem` over a
`node:fs/promises`-shaped object. It wires up only what a mounted volume can
actually serve, and everything else fails rather than pretends.

## Read and write

```ts
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Stream from "effect/Stream"

const roundTrip = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory("/workspace", { recursive: true, mode: 0o700 })
  yield* fs.writeFileString("/workspace/notes.txt", "first\n")
  yield* fs.writeFileString("/workspace/notes.txt", "second\n", { flag: "a" })
  return yield* fs.readFileString("/workspace/notes.txt")
})
```

The served operations are `readFile`, `readFileString`, `writeFile`,
`writeFileString`, `stream`, `makeDirectory`, `readDirectory`, `stat`,
`realPath`, `remove`, `access`, and `exists`.

## The options are honoured, not dropped

| Option                                       | What it does here                                                                                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readDirectory({ recursive })`               | Walked by this adapter, since the slice has no recursive `readdir`. Entries come back as `parent/child`, the way Node reports them.                        |
| `access({ readable, writable })`             | Answered from the reported `mode` bits, because a mounted volume has no user identity. A path that exists without the permission fails `PermissionDenied`. |
| `access({ ok })`                             | The existence check a bare `access` already performs.                                                                                                      |
| `makeDirectory({ mode })`                    | Forwarded, so a directory asked for as `0o700` is not created `0o755`.                                                                                     |
| `writeFile({ flag, mode })`                  | Forwarded, so `{ flag: "a" }` appends instead of truncating and `{ flag: "wx" }` fails `AlreadyExists`.                                                    |
| `realPath`                                   | Canonicalized through the backend's own `realpath` when it has one, so a `..` after a link names the parent of the link's target.                          |
| `exists`                                     | `false` only for a path that is absent. Every other backend failure propagates, so a refusal to look is never reported as absence.                         |
| `stream({ offset, bytesToRead, chunkSize })` | Honoured, and refused when they are not whole byte counts.                                                                                                 |

A recursive listing lists a symlinked directory without descending into it when
the backend has `lstat`, matching Node. A backend with only `stat` follows the
link, so the walk refuses to revisit a directory it has already canonicalized,
and a backend with neither `lstat` nor `realpath` is additionally capped at 128
levels. See [Injected backends](/concepts/injected-backends/).

## Stream a bounded slice

```ts
const head = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  return yield* Stream.runCollect(
    fs.stream("/workspace/big.log", { bytesToRead: 1024, chunkSize: 256 })
  )
})
```

Reads use bounded file-handle chunks rather than loading the whole file. A chunk
is 64 KiB when you name no size, and at most 64 MiB when you do, because the
buffer is an allocation this adapter makes on your behalf in a heap the whole
page shares. A bound that is not a whole, non-negative byte count is refused
rather than clamped: a negative `offset` is not "the start".

## What fails, and how

Unsupported operations answer with a `PermissionDenied` `PlatformError`, which is the honest
answer for a backend with no symlink creation, no writable file handles, and no
watcher: `chmod`, `chown`, `copy`, `copyFile`, `glob`, `link`, `symlink`,
`readLink`, `open`, `sink`, `truncate`, `watch`, and the
four `makeTemp*` operations. `sink` is among them because the slice has no
writable handle to append through, so its incremental contract cannot be
honoured. Each gap that turns out to matter becomes a ticket, not a
silently-wrong implementation.

Errors the backend throws are mapped onto the `PlatformError` tag that carries
their meaning, with the original kept as the `cause`:

| Backend code                 | Tag                |
| ---------------------------- | ------------------ |
| `ENOENT`                     | `NotFound`         |
| `EEXIST`                     | `AlreadyExists`    |
| `EACCES`, `EPERM`            | `PermissionDenied` |
| `EISDIR`, `ENOTDIR`, `ELOOP` | `BadResource`      |
| `EBUSY`                      | `Busy`             |
| anything else                | `Unknown`          |

Collapsing them onto `Unknown` would throw away the one thing a caller can
branch on: `exists` has to tell "not there" from "could not look".

## Paths and text

A tab has no working directory, so a relative path handed to `realPath` resolves
against the volume root rather than an ambient `process.cwd()` that does not
exist. `..` above the root is dropped, the way a POSIX resolver drops it.

Strings are UTF-8 through the standard `TextDecoder` and `TextEncoder`. An
encoding `TextDecoder` does not know fails as `BadArgument`, invalid byte
sequences decode to the replacement character, which is `TextDecoder`'s
non-fatal default, and paths are used exactly as given with no Unicode
normalization.

## Writes are not stored until the mount syncs

An async-mirror ZenFS backend acknowledges a write before it reaches IndexedDB
or OPFS. Call the mount's `sync()` after writes that must survive a reload. This
adapter does not own the mount.

Publication delegates `rename` and `utimes` to the mounted backend. If either
method is absent, that operation fails with `PermissionDenied`. `realPath`
requires backend `realpath`; it never silently normalizes lexically.
The isolation layer requires workspace root `/` and fails typed otherwise.
