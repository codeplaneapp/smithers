```ts
import { NodeHost } from "@smthrs/platform-node"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("printf", ["hello"]))
}).pipe(Effect.provide(NodeHost.layer))
```

:::warning
This entry point is Node-only by construction: it resolves
`node:child_process`. `scripts/browser-check.mjs` pins that.
:::

There is no shell service. Running a command is Effect's `ChildProcess` /
`ChildProcessSpawner`; a wall-clock budget is `Effect.timeout` around the
effect, and cancellation is fiber interruption, never an `AbortSignal`. There is
no HTTP service either: an outgoing request is Effect's `HttpClient`, provided
here as `NodeHttpClient.layerUndici`, which installs no redirect interceptor and
so leaves every hop visible to [@smthrs/kernel](/api/kernel). See
[design decisions](/design-decisions) for why the old `Shell` and
`HttpTransport` wrappers were deleted.

## Requirements

| Requirement                                        | Why                                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Node.js >=22.19.0                                  | the durable runtime the release contract supports                                                         |
| CPython 3 at `/usr/bin/python3`                    | `AtomicFileSystem` runs every filesystem syscall through it                                               |
| that interpreter's `os` module supporting `dir_fd` | with `O_NOFOLLOW` and `O_DIRECTORY`, for `open`, `mkdir`, `readlink`, `rename`, `rmdir`, `stat`, `unlink` |
| a POSIX host                                       | Windows has none of those primitives and is unsupported                                                   |

The interpreter is a real prerequisite, not a soft one, and it fails LATE by
design. `NodeHost.layer` builds cleanly on a host without it, because the
executable is re-validated per request rather than once at construction: the
file a path names can be replaced while a host runs, and a check that happened
only at boot would be a check about a file that is no longer there. The
consequence is that on `node:22-slim`, `node:22-alpine`, or a distroless image
the layer builds, the run starts, and the first guarded filesystem call inside a
flow body fails `PermissionDenied`. Install `python3`, or point the adapter at
the interpreter you do have:

```ts
import { AtomicFileSystem } from "@smthrs/platform-node/AtomicFileSystem"

const filesystem = AtomicFileSystem.layerWith({ executable: "/usr/local/bin/python3" })
```

## Entry points

| Import                                   | Source                                                                                                                     | Platform |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------- |
| `@smthrs/platform-node`                  | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/platform-node/src/index.ts)                       | Node     |
| `@smthrs/platform-node/NodeHost`         | [src/NodeHost.ts](https://github.com/smithersai/smithers/blob/main/packages/platform-node/src/NodeHost.ts)                 | Node     |
| `@smthrs/platform-node/AtomicFileSystem` | [src/AtomicFileSystem.ts](https://github.com/smithersai/smithers/blob/main/packages/platform-node/src/AtomicFileSystem.ts) | Node     |
| `@smthrs/platform-node/HostLiveness`     | [src/HostLiveness.ts](https://github.com/smithersai/smithers/blob/main/packages/platform-node/src/HostLiveness.ts)         | Node     |
| `@smthrs/platform-node/ProcessReaper`    | [src/ProcessReaper.ts](https://github.com/smithersai/smithers/blob/main/packages/platform-node/src/ProcessReaper.ts)       | Node     |

The barrel exports `NodeHost`, `HostLiveness`, and `ProcessReaper`.
`AtomicFileSystem` is reached as `NodeHost.AtomicFileSystem` or through its own
subpath, never from the barrel.

## Layers

| Layer                                       | Jj bound to           | Containment |
| ------------------------------------------- | --------------------- | ----------- |
| `NodeHost.layer`                            | the process directory | no          |
| `NodeHost.layerAt(root)`                    | one absolute root     | no          |
| `NodeHost.layerContained(options?)`         | the process directory | yes         |
| `NodeHost.layerContainedAt(root, options?)` | one absolute root     | yes         |

The contained pair is what `@smthrs/flows`' `NodeRuntime` composes. Each child
gets a `SIGTERM`-then-`SIGKILL` deadline and a `ProcessLedger` record, `jj` runs
through that same spawner rather than starting its own children, and
`ProcessReaper.reap` sweeps the records a crashed incarnation left behind while
the layer is built. The ledger is a requirement rather than a default: only the
program knows whether it has a durable one.

`NodeHost.ContainedOptions` is `graceMs` plus the reaper's `ownerPid` and
`system`. It deliberately omits `ContainedSpawner.Options.platform`: the spawner
underneath is Effect's, which detaches by the real `process.platform`, so a
caller-supplied platform would record a process group the child does not lead
and strand the orphan behind a `no-group` refusal.

## Filesystem

`AtomicFileSystem.layer` is `NodeHost`'s filesystem slot, and it is not Effect's
`NodeFileSystem`. Node exposes no `openat(2)` or `renameat(2)`, so the adapter
delegates each operation to a POSIX helper that opens the workspace root once,
walks every component with `O_NOFOLLOW`, and performs the final syscall relative
to a pinned parent descriptor. Under [@smthrs/kernel](/api/kernel)'s
`FileSystem.layer` that is what makes a symlink swapped in after authorization
unable to redirect the operation, and it is why the bundle returns
`PermissionDenied` for an out-of-root path, a hard link, a symlink, or a special
file rather than performing raw effects.

| Constant or constructor               | What it is                                                            |
| ------------------------------------- | --------------------------------------------------------------------- |
| `AtomicFileSystem.layer`              | the adapter with every default                                        |
| `AtomicFileSystem.layerWith(options)` | the same, with the interpreter and the ceilings configured            |
| `AtomicFileSystem.defaultExecutable`  | `/usr/bin/python3`                                                    |
| `AtomicFileSystem.defaultLimits`      | 16 MiB content, 24 MiB request, 24 MiB response, 64 KiB helper stderr |
| `AtomicFileSystem.defaultConcurrency` | `os.availableParallelism()`                                           |
| `AtomicFileSystem.defaultTimeoutMs`   | 300000                                                                |
| `AtomicFileSystem.program`            | the helper source, exported so its own protocol guards can be driven  |

**Cost.** Every operation is one CPython fork, roughly 130 ms on a current host.
That is the price of descriptor-relative confinement on a runtime with no
`openat`, and it is why the adapter carries a process ceiling: without one, an
`Effect.forEach(files, read, { concurrency: "unbounded" })` over fifty entries
would start fifty interpreters at once. Batch a wide fan-out, or raise
`concurrency` deliberately. A directory listing is one fork for the whole tree,
so `readDirectory(root, { recursive: true })` costs far less than a read per
entry.

Every field of `Options` except `executable` is read once, when the layer is
built, so the ceilings cannot change under a running host.

**Glob.** The helper cannot call Node's globber, so it implements the grammar:
`*` and `?` inside one segment, `[...]` classes with `!` or `^` negation, `**`
across zero or more whole segments, `{a,b}` alternation, a trailing `/` for
directory-only matching, and the dotfile rule, which keeps a wildcard out of a
name beginning with `.` while letting a segment that spells the dot, `.*` or
`[.]*`, match one. Exclusions prune: excluding a directory excludes everything
below it, an absolute exclude is rewritten against the glob root so it applies
to the same names the selecting pattern does, and a trailing `**` in an exclude
removes what is under a directory while leaving the directory entry itself,
which is the native globber's own asymmetry between selecting and excluding.
Matching is segment-wise and linear in the candidate's length, never a compiled
regular expression, because a pattern of repeated `*x` fragments costs a regex
engine exponential backtracking.

Two grammar bounds are refusals rather than silent truncation: a pattern longer
than 4096 characters, and one whose braces expand past 64 alternatives, both
fail as `BadArgument`. Four constructs are deliberately not implemented and
match nothing: extglob (`+(a|b)`), POSIX classes (`[[:digit:]]`), numeric and
alphabetic brace ranges (`{1..3}`), and backslash escaping, which is an ordinary
character here. Node's own globber does not agree with itself about one input
across the supported range either: on 22.19.0 a dotted segment after `**`
(`**/.hidden`) matches nothing, and on 24 it matches the dotfiles. The adapter
follows the newer reading.

**Removal.** `remove(path, { recursive: true })` walks iteratively with an
explicit descriptor stack: depth is bounded at 512 levels, the total number of
entries visited at 100000, and each directory is read incrementally so a wide
one is refused rather than materialized. Progress is partial on refusal, since
entries already unlinked stay unlinked. `force: true` succeeds for a path whose
ancestors do not exist, exactly as `fs.rm` does.

## Liveness and reaping

`HostLiveness.isAlive({ hostId })` is the probe `EngineStore` consults before it
takes a run whose recorded owner it is not: an owner on a different host reads
as alive, and an owner on this host reads as alive exactly while its pid is
signalable. `@smthrs/run-store`'s `Ownership.sameHostPidProbe` answers the same
question differently for a foreign host, and the two are not interchangeable;
the JSDoc on `isAlive` names both inputs on which they disagree.

`ProcessReaper.reap` kills the process groups a crashed incarnation of the same
`hostId` abandoned. It signals a record only when every guard holds: the numbers
name something the platform can signal, the group is not this host's, the owner
is gone, and the pid still names the process the record describes. A record it
cannot verify, on a host with no usable `ps`, is kept rather than killed:
no evidence never authorizes a `SIGKILL`.

| Refusal               | Retired |
| --------------------- | ------- |
| `owner-alive`         | no      |
| `identity-unverified` | no      |
| `no-group`            | yes     |
| `own-group`           | yes     |
| `invalid-record`      | yes     |
| `pre-boot`            | yes     |
| `process-gone`        | yes     |
| `identity-mismatch`   | yes     |
| `kill-failed`         | no      |

Windows reaping is unsupported best-effort. The release contract lists Windows
as unsupported and `AtomicFileSystem` fails every operation closed there, but
`systemFor("win32")` still reaches `taskkill /T /F` through the sweep rather
than retiring every record unsignalled, because an excluded feature that appears
to work partially is worse than one that says what it does.

## Conformance

The package runs the shared suite from
[`@smthrs/kernel/test/contract`](/api/kernel) twice: once with explicit
expectations, and once (`NodeHostDefaults`) taking every default the suite
offers, against a loopback HTTP server so the `HttpClient` success path is
actually asserted rather than only its refusal. On top of that, the atomic
filesystem is compared against `@effect/platform-node`'s own adapter: open
flags, errno classification, `stat` fields, and the glob grammar are asserted
row by row against the native implementation rather than against a hand-written
expectation. Containment is driven over real detached process groups.

## Reading next

[@smthrs/kernel](/api/kernel) owns the closed list and decorates these same tags
with capability checks. [@smthrs/platform-bun](/api/platform-bun) and
[@smthrs/platform-browser](/api/platform-browser) are the sibling bundles.
