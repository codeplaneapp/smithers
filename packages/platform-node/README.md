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

`NodeHost.layerAt` and `NodeHost.layerContainedAt` are the same two layers with
`Jj` bound to one absolute repository root rather than the process working
directory; `@smthrs/flows`' `NodeRuntime` composes `layerContainedAt`.

`NodeHost.layerContained` is the bundle with process containment turned on. It
composes `@smthrs/kernel`'s `ContainedSpawner` over the raw spawner, so every
child gets a `SIGTERM`-then-`SIGKILL` deadline and a `ProcessLedger` entry, and
it runs one `ProcessReaper.reap` sweep while the layer is built, killing the
process groups a previous incarnation of the same host abandoned. It requires a
`ProcessLedger` because the durable half is only as good as the journal
underneath it: `ProcessLedger.layer` inherits a crashed incarnation's
processes, `ProcessLedger.layerMemory` contains this one and nothing more.

```ts
import { ProcessLedger } from "@smthrs/kernel"
import { NodeHost } from "@smthrs/platform-node"
import { Layer } from "effect"

const host = Layer.provide(
  NodeHost.layerContained({ graceMs: 2000 }),
  ProcessLedger.layer({ hostId: "engine-1", ownerPid: process.pid })
)
```

`layerContained` also builds `Jj` over the contained spawner, so a `jj`
invocation a crashed host left running is a ledger record like any other rather
than a process that went around the host.

`ProcessReaper` is narrow on purpose, because a stored pid outlives the process
that wrote it and the operating system reuses the number. It signals a record
only when the record belongs to a different incarnation of the same `hostId`,
its numbers name something this platform can signal (`pgid == pid` above 1 on
POSIX, `pgid: null` on Windows), that target is neither this process's pid nor
its real process group, the owner that wrote it is provably gone (`ESRCH`, never
`EPERM`), the record was written during this boot, and the pid's start time still
matches the record. A host that cannot ASK for the start time refuses too: no
evidence never authorizes a `SIGKILL`.

Each refusal decides whether the record is retired through
`flows.host.process-reap-skipped.v1` or left inherited for the next incarnation:

| Refusal               | Meaning                                                     | Retired |
| --------------------- | ----------------------------------------------------------- | ------- |
| `owner-alive`         | the incarnation that started it is still running            | no      |
| `identity-unverified` | this host could not read the pid's start time               | no      |
| `kill-failed`         | the signal was refused, so it is tried again                | no      |
| `no-group`            | it shared its owner's group, so there is no group to signal | yes     |
| `own-group`           | it named this host's own group or pid                       | yes     |
| `invalid-record`      | its numbers name nothing this platform may signal           | yes     |
| `pre-boot`            | it was written before this machine booted                   | yes     |
| `process-gone`        | the pid it names does not exist                             | yes     |
| `identity-mismatch`   | the pid exists but did not start when the record says       | yes     |

A `pre-boot` refusal covers a two-second window after the computed boot instant,
because `uptime` is second-granular. A group spawned inside that window is
retired unsignalled and never reaped, which is the deliberate price of refusing
to kill on an instant the host can only place to the nearest second.

Windows reaping is unsupported best-effort: the release contract lists Windows
as unsupported and `AtomicFileSystem` fails every operation closed there, but
`systemFor("win32")` still reaches `taskkill /T /F` through the sweep rather than
retiring every record unsignalled.

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

The barrel exports three namespaces: `NodeHost`, `HostLiveness`, and
`ProcessReaper`. `AtomicFileSystem` is deliberately not among them; it is reached
as `NodeHost.AtomicFileSystem` or through the `@smthrs/platform-node/AtomicFileSystem`
subpath.

| Module             | What it provides                                                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NodeHost`         | The complete closed Host bundle: `layer`, `layerAt`, `layerContained`, `layerContainedAt`, `ContainedOptions`; re-exports `AtomicFileSystem`, `ProcessReaper`, `NodeCrypto`, and Effect's raw `NodeFileSystem`, spawner, and `HttpClient` |
| `AtomicFileSystem` | Descriptor-relative/no-follow Node filesystem layer: `layer`, `layerWith`, `Options`, `Limits`, `defaultExecutable`, `defaultLimits`, `defaultConcurrency`, `defaultTimeoutMs`, `program`                                                 |
| `HostLiveness`     | Whether a recorded run owner is still alive: `isAlive`, `Owner`, `Options`                                                                                                                                                                |
| `ProcessReaper`    | Killing the process groups a dead incarnation of this host abandoned: `reap`, `layer`, `System`, `SystemOptions`, `StartTime`, `Refusal`, `posixSystem`, `posixSystemWith`, `windowsSystem`, `systemFor`, `defaultPsExecutable`           |

`NodeCrypto` is re-exported for a different reason than the rest: `Crypto` is not
a Host service, so it is not in the closed list, but every durable composition
needs one and a program that already depends on this package for its host should
not need a second dependency for the digest.

`AtomicFileSystem`'s ceilings are `defaultLimits` (16 MiB of file content, 24 MiB
of framed request and response, 64 KiB of retained helper diagnostics), a
listing ceiling of 100000 entries, a recursive-removal depth ceiling of 512
levels, `defaultConcurrency` helper processes at once, and `defaultTimeoutMs`
(300000) per helper. Every one of them except the executable is read once, when
the layer is built. Each operation is one CPython fork, roughly 130 ms, so batch
a wide fan-out rather than reading a directory one entry at a time.

`glob` implements the grammar itself rather than calling Node's globber: `*` and
`?` within a segment, `[...]` classes with `!` or `^` negation, `**` across zero
or more whole segments, `{a,b}` alternation, a trailing `/` for directory-only
matching, and the dotfile rule, which keeps a wildcard out of a leading dot while
letting a segment that spells the dot match one. Exclusions prune whole subtrees,
an absolute exclude is rewritten against the glob root, and a trailing `**` in an
exclude leaves the directory entry itself. A pattern past 4096 characters, or one
whose braces expand past 64 alternatives, is a `BadArgument`. Extglob
(`+(a|b)`), POSIX classes (`[[:digit:]]`), numeric brace ranges (`{1..3}`), and
backslash escaping are not implemented and match nothing. The parity suite
compares every supported row against `@effect/platform-node`'s own globber; the
two answers Node itself gives differently on 22 and 24 are pinned separately.

`HostLiveness.isAlive` is the answer `EngineStore` steals runs on. An owner
from a different host is alive, because a pid means nothing across machines; an
owner from this host is alive exactly while its pid is signalable. Both ways of
being wrong are unequal, so the rule errs toward "alive": a stranded run waits
for an operator, while a stolen live run executes twice.

```ts
import { HostLiveness } from "@smthrs/platform-node"

const isAlive = HostLiveness.isAlive({ hostId: "engine-1" })
```

**Node-only by construction.** The bundle resolves `node:child_process` and
friends; `scripts/browser-check.mjs` at the repository root pins that.
