---
title: "Configure the filesystem helper"
description: "Point AtomicFileSystem at a different CPython interpreter and set the byte ceilings, process ceiling, and timeout that bound what one filesystem call may cost."
---

Use this when the host installs CPython somewhere other than
`/usr/bin/python3`, or when the default ceilings do not fit the workload.
`AtomicFileSystem.layerWith` takes all of it in one options object.

```ts
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"

const filesystem = AtomicFileSystem.layerWith({
  executable: "/usr/local/bin/python3",
  concurrency: 4,
  timeoutMs: 60_000,
  limits: { content: 4 * 1024 * 1024 }
})
```

`layerWith` returns a `Layer<FileSystem.FileSystem>` with no requirements, the
same shape as `AtomicFileSystem.layer`. Substitute it wherever the bundle would
have used the default.

## Point at a different interpreter

```ts
const filesystem = AtomicFileSystem.layerWith({ executable: "/usr/local/bin/python3" })
```

The path must be absolute. It is configuration, never discovery: the adapter
does not search `PATH`, because Python's `-I` isolates an interpreter only
after one has been chosen, and a `python3` planted on an injected `PATH` would
already have executed arbitrary code inside the process that holds the pinned
root descriptor.

The executable is the one field re-validated on every request, as an absolute,
executable regular file outside the confined workspace. That is deliberate: the
file a path names can be replaced while a host runs, so a check that happened
only at construction would be a check about a file that is no longer there. It
is also why a host with no interpreter builds cleanly and then fails every
guarded filesystem call with `PermissionDenied`.

## Set the byte ceilings

`limits` accepts a partial `Limits`; the fields you omit keep their defaults.

| Field      | Default | What it bounds                                                                           |
| ---------- | ------- | ---------------------------------------------------------------------------------------- |
| `content`  | 16 MiB  | the bytes one `readFile` or `writeFile` may carry                                        |
| `request`  | 24 MiB  | the framed request, refused before an interpreter is even started                        |
| `response` | 24 MiB  | the framed response, which is what a directory listing is charged against as it is built |
| `stderr`   | 64 KiB  | the diagnostic text retained from a failing helper                                       |

`request` and `response` are larger than `content` because base64 expands
16 MiB to 22369624 bytes, which has to fit.

Every one of these is a contract rather than a tuning knob: without them a
large file, a large directory tree, or a malfunctioning helper makes the host
allocate until it dies. Raising one raises what a single call can cost the
host.

Lowering `response` has one consequence worth knowing. It bounds the rejection
envelope too, so a ceiling small enough to cut one off degrades that
operation's typed reason to the fail-closed one, and you lose the specific
errno.

## Set the process and time ceilings

The two ceilings that decide whether the host survives a wide fan-out are not
byte ceilings.

| Field         | Default                     | What it bounds                                  |
| ------------- | --------------------------- | ----------------------------------------------- |
| `concurrency` | `os.availableParallelism()` | how many helper interpreters may run at once    |
| `timeoutMs`   | 300000                      | how long one helper may run before it is killed |

Every operation is one CPython fork, roughly 130 ms. Without a process ceiling,
an `Effect.forEach(files, read, { concurrency: "unbounded" })` over fifty paths
would start fifty interpreters at once.

`timeoutMs` is a backstop, not a latency budget. A read at the content ceiling
over a slow disk has to fit under it, so five minutes is generous; what it
bounds is a helper that will never answer at all. A helper that passes the
deadline is killed and the operation fails closed.

## Ceilings are read once

Every field except `executable` is read once, when the layer value is
constructed. `Options` is a plain object the caller still holds, and a byte
ceiling that changes under a running host is not a ceiling.

The reading happens outside the layer body, so two compositions of the same
layer value enforce the same ceilings and share one process semaphore. Building
the layer twice does not double the concurrency budget.

## Check the defaults from code

The defaults are exported, so a program that reports its own configuration does
not have to restate them:

```ts
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"

AtomicFileSystem.defaultExecutable // "/usr/bin/python3"
AtomicFileSystem.defaultLimits // { content, request, response, stderr }
AtomicFileSystem.defaultConcurrency // os.availableParallelism()
AtomicFileSystem.defaultTimeoutMs // 300000
```
