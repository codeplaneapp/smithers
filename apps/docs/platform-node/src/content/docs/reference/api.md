---
title: "API reference"
description: "Node.js Host bundle for flows: Effect's Node platform services composed into the closed Host surface"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-node/docs/api.md"
---

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
so leaves every hop visible to [@smthrs/kernel](https://kernel.smithers.sh/reference/api/). The old `Shell`
and `HttpTransport` wrappers were deleted for the same reason.

The complete host bundles require jj 0.39.0 or newer. Each bundle builds its jj
layer with one version probe; construction can fail with `JjError`, including
`not_installed` or `unsupported_version`. The contained bundles route that probe
through their process spawner and retire its ledger entry when it exits.

## Requirements

| Requirement                                        | Why                                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Node.js >=22.19.0                                  | the durable runtime the release policy supports                                                           |
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

| Import                                   | Source                                                                                                                                    | Platform |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `@smthrs/platform-node`                  | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/src/index.ts)                       | Node     |
| `@smthrs/platform-node/NodeHost`         | [src/NodeHost.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/src/NodeHost.ts)                 | Node     |
| `@smthrs/platform-node/AtomicFileSystem` | [src/AtomicFileSystem.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/src/AtomicFileSystem.ts) | Node     |
| `@smthrs/platform-node/HostLiveness`     | [src/HostLiveness.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/src/HostLiveness.ts)         | Node     |
| `@smthrs/platform-node/ProcessReaper`    | [src/ProcessReaper.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/src/ProcessReaper.ts)       | Node     |

The barrel exports `NodeHost`, `HostLiveness`, and `ProcessReaper`.
`AtomicFileSystem` is reached as `NodeHost.AtomicFileSystem` or through its own
subpath, never from the barrel.

`NodeHost` also re-exports the pieces it composes, so a program that wants one
slot rather than the whole bundle needs no second dependency:

| Re-export                          | What it is                                                       |
| ---------------------------------- | ---------------------------------------------------------------- |
| `NodeHost.AtomicFileSystem`        | this package's descriptor-relative filesystem, the bundle's slot |
| `NodeHost.ProcessReaper`           | this package's containment sweep                                 |
| `NodeHost.NodeCrypto`              | Effect's Node `Crypto`                                           |
| `NodeHost.NodeFileSystem`          | Effect's raw Node filesystem, which carries NO atomic extension  |
| `NodeHost.NodeChildProcessSpawner` | Effect's Node spawner                                            |
| `NodeHost.NodeHttpClient`          | Effect's Undici-backed `HttpClient`                              |

`NodeCrypto` is there for a different reason from the rest. `Crypto` is not a
Host service, so it is not in the closed list, but every durable composition
needs one and a program that already depends on this package for its host
should not need a second dependency for the digest.

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
to a pinned parent descriptor. Under [@smthrs/kernel](https://kernel.smithers.sh/reference/api/)'s
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
`[.]*`, match one. Exclusions prune the walk itself: excluding a directory
excludes everything below it, and nothing under an excluded directory is listed,
counted against the entry ceiling, or charged against the response ceiling. An
exclusion that names the root stops before the walk begins. An absolute exclude
is rewritten against the glob root so it applies to the same names the selecting
pattern does. A trailing `**` spans zero segments, so it also names its own
anchor: a directory always, and a non-directory only when every segment before it
is literal, which is the shortcut the native globber takes when it can address
the path directly rather than read a directory. `top.txt/**` names the file;
`t*.txt/**` names nothing. A one-member class is the literal it spells, so `[.]`
is a `.` path segment: the globber drops a SPELLED `.` before it parses and
collapses `[.]` only afterwards, so this one survives and, as the last segment,
names its anchor under the same rule. One addition: a `**` immediately before it
addresses nothing, so `**/[.]` names nothing while `**/deep/[.]` names the
directory. Anywhere but last, and in an exclusion, a `.` segment names an entry
no directory holds. Matching is segment-wise and linear in the candidate's
length, never a compiled regular expression, because a pattern of repeated `*x`
fragments costs a regex engine exponential backtracking.

Two grammar bounds are refusals rather than silent truncation: a pattern longer
than 4096 characters, and one whose braces expand past 64 alternatives, both
fail as `BadArgument`. Both are enforced before any expansion or any walking, so
an over-large pattern costs no listing and answers with the typed refusal rather
than with a fail-closed transport error. So do the three constructs this grammar
does not implement: extglob (`+(a|b)`), POSIX classes (`[[:digit:]]`), brace
ranges (`{1..3}`). Each of them means something to the
native globber, so reading them as ordinary characters would not fail; it would
answer a different question, and in an exclusion that means handing the caller
the very paths it forbade. The refusal therefore covers the exclude list as well
as the pattern, and it recognises a character class, so `[!(]*` is an ordinary
negated class and not an extglob.

Backslashes follow Node's POSIX rules instead: an absolute selector and every
exclude drop them while leaving following wildcard magic active; a relative
selector containing one matches nothing. The public filesystem path is
absolute, and the direct atomic protocol preserves the relative empty answer.

Three answers are pinned rather than copied, because the native globber gives no
single answer to copy.

1. **Case.** Matching is case-sensitive on every host. Node's globber passes
   `nocase: isMacOS || isWindows` with `nocaseMagicOnly: true`. On a
   case-insensitive host a magic segment folds case (`*.TXT` finds `upper.txt`),
   a literal segment the matcher decides is compared exactly (`**/MID.txt`
   misses `mid.txt`), and a literal segment Node addresses directly comes back
   with the pattern's own spelling (`TOP.TXT` returns `TOP.TXT`), even though the
   directory does not hold that spelling. The adapter returns only names its
   walk found. A pattern whose meaning depends on which host reads it is worse
   than one that means the same everywhere, and worst of all in an exclusion,
   so the adapter keeps one rule everywhere.
2. **A trailing `**` in an exclusion** removes what is under a directory and
   leaves the directory entry itself. Node's own answer here depends on the
   shape of the SELECTING pattern: `**/*` with `exclude: ["nested/**"]` keeps
   `nested`, and `**` with the same exclusion drops it. The adapter gives one
   answer for every selector. Consequently, the directory-only `**/` names
   directories below its own anchor but not that anchor: with `exclude: ["**/"]`,
   `**` keeps the root and its files while pruning every directory.
   Node empties the answer instead.
3. **A dotted segment after `**`.** On 22.19.0 `**/.hidden` matches nothing and
   on 24 it matches the dotfiles. The adapter follows the newer reading.

**Removal.** `remove(path, { recursive: true })` walks iteratively with an
explicit descriptor stack: depth is bounded at 512 levels and the total number
of entries visited at 100000, counted as each directory is read, so a hostile
wide directory is refused after 100000 names rather than allocated whole. One
directory's names are read before any of its entries is unlinked, because
unlinking from a directory while iterating it is undefined; the entry ceiling
is what bounds the names held across the whole walk. Progress is partial on
refusal, since entries already unlinked stay unlinked. `force: true` succeeds
for a path whose ancestors do not exist, exactly as `fs.rm` does.

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
is gone, and the pid still names the process the record describes. Two of those
guards are questions put to `ps`: this process's own group, and when the
recorded pid started. Either can go unanswered on a host with no usable one, and
an unanswered guard refuses, because a guard that did not run is not a guard
that passed. No evidence never authorizes a `SIGKILL`.

A refusal also decides whether the record is retired. Retiring says in the
journal that nothing was signalled and stops every later incarnation
re-examining a number the operating system has moved on from, so only a refusal
a later incarnation cannot answer differently is final.

| Refusal               | Retired |
| --------------------- | ------- |
| `owner-alive`         | no      |
| `identity-unverified` | no      |
| `own-group-unknown`   | no      |
| `no-group`            | yes     |
| `own-group`           | yes     |
| `invalid-record`      | yes     |
| `pre-boot`            | yes     |
| `process-gone`        | yes     |
| `identity-mismatch`   | yes     |
| `kill-failed`         | no      |

Windows reaping is unsupported best-effort. The release policy lists Windows
as unsupported and `AtomicFileSystem` fails every operation closed there, but
`systemFor("win32")` still reaches `taskkill /T /F` through the sweep rather
than retiring every record unsignalled, because an excluded feature that appears
to work partially is worse than one that says what it does.

## Conformance

The package runs the shared suite from
[`@smthrs/kernel/test/contract`](https://kernel.smithers.sh/reference/api/) twice: once with explicit
expectations, and once (`NodeHostDefaults`) taking every default the suite
offers, against a loopback HTTP server so the `HttpClient` success path is
actually asserted rather than only its refusal. On top of that, the atomic
filesystem is compared against `@effect/platform-node`'s own adapter: open
flags, errno classification, `stat` fields, and the glob grammar are asserted
row by row against the native implementation rather than against a hand-written
expectation. Containment is driven over real detached process groups.

## Reading next

[@smthrs/kernel](https://kernel.smithers.sh/reference/api/) owns the closed list and decorates these same tags
with capability checks. [@smthrs/platform-bun](https://platform-bun.smithers.sh/reference/api/) and
[@smthrs/platform-browser](https://platform-browser.smithers.sh/reference/api/) are the sibling bundles.
