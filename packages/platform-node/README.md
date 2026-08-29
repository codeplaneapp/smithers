# @smthrs/platform-node

The Node.js Host bundle for Smithers.

`@effect/platform-node` already ships `FileSystem`, `Path`,
`ChildProcessSpawner`, and an Undici-backed `HttpClient`. This package composes
the complete closed five-tag Host surface, including the Node `Jj` adapter from
`@smthrs/jj` and the atomic filesystem adapter described below.

```ts
import { NodeHost } from "@smthrs/platform-node"
import { Effect } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("git", ["status", "--short"]))
})

Effect.runPromise(Effect.provide(program, NodeHost.layer))
```

There is no shell service. Running a command is Effect's `ChildProcess` /
`ChildProcessSpawner`; a wall-clock budget is `Effect.timeout` around the
effect, and cancellation is fiber interruption, not an `AbortSignal`.

There is no HTTP service either. An outgoing request is Effect's `HttpClient`,
and the bundle provides `NodeHttpClient.layerUndici`. Undici installs no
redirect interceptor, so every hop stays a separate, checkable request.

Wrap the bundle in `@smthrs/kernel`'s `HostServices.layer` to get the
permission-aware projection, where `proc:spawn` is checked against the rendered
command line before any process starts and `net:get` / `net:post` is checked
against the host of every URL — including each redirect hop.

Node's JavaScript filesystem API does not expose `openat(2)`/`renameat(2)` or a
root-handle equivalent. `AtomicFileSystem.layer` supplies those semantics on a
POSIX host through a small Python helper: each request pins the canonical
workspace directory, walks components with `O_NOFOLLOW`, and performs the
operation relative to directory descriptors. `NodeHost.layer` uses that
adapter. Missing Python or missing POSIX descriptor APIs produce a typed,
fail-closed `PermissionDenied`; the implementation never falls back to a
check-then-path operation. Wrapping the raw re-exported `NodeFileSystem.layer`
directly also fails closed because it carries no atomic extension.

The adapter covers the operations that can be expressed as one
descriptor-relative request: `readFile`, `readFileString`, `writeFile`,
`writeFileString`, `exists`, `stat`, `readLink`, `realPath`, `makeDirectory`,
`readDirectory`, `remove`, `rename`, and `glob`. Everything else on the
`FileSystem` surface — `open`, `stream`, `sink`, `watch`, `copy`, `copyFile`,
`link`, `symlink`, `access`, `chmod`, `chown`, `truncate`, `utimes`, and the
`makeTemp*` family — returns a live handle or a stream that Node cannot open
relative to a pinned descriptor, so under the kernel decorator each one fails
closed with the same typed `PermissionDenied` rather than silently reverting to
a path-based call. Reach for the raw `NodeFileSystem` outside the capability
boundary if a program needs them.

The helper runs isolated from the ambient environment (`python3 -I -X utf8`).
Isolated mode keeps the host process's working directory, `PYTHONPATH`, and the
user site directory off the module search path, so a `base64.py` written into
the workspace the adapter is confining cannot be imported and executed inside
the process that holds the pinned root descriptor. `-X utf8` pins the request,
the response, and the filesystem encoding to UTF-8, so a host started under a
legacy locale addresses the same file and writes the same bytes as one started
under a UTF-8 locale. The trade-off is that `PYTHONHOME` is ignored as well: an
interpreter that needs it fails closed like any other unusable helper.

Two deliberate confinement refusals are worth knowing before adopting the
adapter: a regular file with more than one hard link cannot be opened
(a hard link is not a symlink, so `O_NOFOLLOW` cannot confine it), and a
symlink is never traversed, opened, renamed, or removed. Directory listing is
the exception — it names a symlink entry and never descends through it,
because listing resolves nothing and refusing would buy no confinement.

Every open of the entry a caller named — read and write alike — is
non-blocking, so a named pipe planted at that name cannot park the adapter
inside `open()` until some other process opens the other end. A write-only
open of a reader-less pipe returns a typed failure instead. Node's own
filesystem waits there indefinitely, which is the one place the adapter is
deliberately stricter than the implementation it mirrors.

The workspace root is addressable like any other directory: `exists`, `stat`,
`readDirectory`, `realPath`, `glob`, and a recursive `makeDirectory` all
answer for it. Removing it, renaming it or onto it, reading it as a file,
writing over it, and a non-recursive `makeDirectory` on it stay refused.

Writes follow Effect's `OpenFlag` contract exactly — `r`, `r+`, `w`, `wx`,
`w+`, `wx+`, `a`, `ax`, `a+`, `ax+` — and are checked against the native Node
filesystem in the test suite. Truncation runs on the opened descriptor rather
than through `O_TRUNC`, so a hard link is refused before the file is modified.
Errno is normalized to the same reasons `@effect/platform-node` reports, with
one addition: a helper failure that carries no errno at all stays
`PermissionDenied` so the boundary fails closed.

## Modules

| Module             | What it provides                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `AtomicFileSystem` | Descriptor-relative/no-follow Node filesystem layer, with typed fail-closed behavior on unsupported hosts                                 |
| `NodeHost`         | The complete closed Host bundle, plus `layer`; re-exports `AtomicFileSystem` and Effect's raw `NodeFileSystem`, spawner, and `HttpClient` |

**Node-only by construction.** The bundle resolves `node:child_process` and
friends; `scripts/browser-check.mjs` at the repository root pins that.
