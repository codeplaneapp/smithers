---
title: "API reference"
description: "Every export of @smthrs/jj and its subpaths: the Jj contract, the JjError vocabulary, the Node, Bun, and browser layers, the binary resolver, and the WASI preview 1 shim."
---

One program, three layers. The body never changes; the import at the top decides
which adapter runs it.

```ts
// Node
import { Jj } from "@smthrs/jj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const jj = yield* Jj
  return yield* jj.snapshot("before the step")
}).pipe(Effect.provide(NodeJj.layer))
```

```ts
// Bun
import { Jj } from "@smthrs/jj"
import * as BunJj from "@smthrs/jj/bun/BunJj"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const jj = yield* Jj
  return yield* jj.snapshot("before the step")
}).pipe(Effect.provide(BunJj.layer))
```

```ts
// Browser
import { Jj } from "@smthrs/jj"
import * as BrowserJj from "@smthrs/jj/browser/BrowserJj"
import * as Effect from "effect/Effect"

const makeProgram = (options: BrowserJj.BrowserJjOptions) =>
  Effect.gen(function*() {
    const jj = yield* Jj
    return yield* jj.snapshot("before the step")
  }).pipe(Effect.provide(BrowserJj.layer(options)))
```

The package root holds the contract, its error, and the no-op layer only, so it
bundles for the browser. Implementations live under `/node`, `/bun`, and
`/browser`. The package depends on `effect` and `@smthrs/capability` (its error
channel names `Permission.PermissionError`); [`@smthrs/kernel`](/api/kernel)
depends on it, because `Jj` is one of the tags in the closed host list.

## @smthrs/jj

The root entry point re-exports every member of `Jj.ts` flat.

### The Jj service

`Jj` is deliberately small: only the operations that make a step reversible.
`snapshot`, `restore`, `diff`, `workspaceAdd`, `workspaceForget`, and `status`
are required of every backend. `root` and `revert` are optional on the type, so
a hand-written test double may leave them out.

| Member                                | Signature                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `snapshot(message?)`                  | `(message?: string) => Effect<{ readonly changeId: ChangeId }, JjFailure>`                      |
| `restore(changeId)`                   | `(changeId: ChangeId) => Effect<void, JjFailure>`                                               |
| `diff(from, to)`                      | `(from: ChangeId, to: ChangeId) => Effect<string, JjFailure>`                                   |
| `workspaceAdd(name, path, revision?)` | `(name: string, path: string, revision?: ChangeId) => Effect<void, JjFailure \| PlatformError>` |
| `workspaceForget(name)`               | `(name: string) => Effect<void, JjFailure>`                                                     |
| `status()`                            | `() => Effect<string, JjFailure>`                                                               |
| `root(from)` (optional)               | `(from: string) => Effect<string, JjFailure \| PlatformError>`                                  |
| `revert(changeId)` (optional)         | `(changeId: ChangeId) => Effect<{ readonly reverted: ReadonlyArray<string> }, JjFailure>`       |

`snapshot` commits the working copy and returns the change id to restore to
later: it closes the current change and opens a fresh one. Node and Bun only
label a closed change that has no existing description.
With no message there is no `describe` at all, because `jj describe` without
`-m` starts `$JJ_EDITOR` and waits for it.

`restore` puts the working copy back to `changeId`, replacing the tree rather
than merging into it. `diff` is a git-format unified diff between two
revisions. `workspaceAdd` adds a named workspace rooted at `path`, one lane per
parallel agent, pinned at `revision` when one is given. `workspaceForget` drops
a named workspace without touching the commits made in it or the directory on
disk. `status` returns the working copy's status as jj prints it.

`root` answers `jj root` for the directory containing `from`, which is correct
for colocated repositories and secondary workspaces that a walk up looking for
`.jj` would get wrong. `revert` applies the reverse of one change and reports
the paths it touched.

`restore` and `revert` exist because one cannot express the other. `restore`
discards everything committed after the recorded point. `revert` undoes one
change and keeps the rest, which is what an operator means by "undo that
attempt".

`PlatformError` is in two error channels because the guarded implementation
canonicalizes a path against the workspace root before it asks for a
capability, and resolving a path is a filesystem operation that can itself fail.

Every layer this package ships defines both optional members anyway, and
answers `not_installed` in the error channel where the backend cannot perform
them. **Feature detection is by error code, never by property absence**:
`"revert" in jj` is true for `makeNoop`, for `BrowserJj.make`, and for
`BrowserJj.layerUnsupported` alike, so a caller that needs to know asks and
reads the code it gets back. An absent capability is a capability with an
answer.

Both optional operations are capability-checked like every other one:
`jj:root` is `sealed` and `jj:revert` is `compensable`.

### Service construction

| Export                 | Signature                               | Meaning                                                                                                               |
| ---------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `Jj`                   | `Context.Service<Jj, Jj>`               | The service key. The tag string is `"@smthrs/jj/Jj"` and is durable identity.                                         |
| `make(impl)`           | `(impl: Jj) => Jj`                      | Brands an implementation as the service, so a new backend is checked where it is written.                             |
| `makeNoop(overrides)`  | `(overrides: Partial<Jj>) => Jj`        | A stub whose every unoverridden method fails `not_installed`, naming the method called.                               |
| `layerNoop(overrides)` | `(overrides: Partial<Jj>) => Layer<Jj>` | `makeNoop` as a layer.                                                                                                |
| `ChangeId`             | `type ChangeId = string`                | The durable handle a run uses to name workspace state. A bare alias, because the value jj prints is the value stored. |

### Failures

| Export                | Signature                                                                                                              | Meaning                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `JjErrorCode`         | `Schema.Literals<["not_installed", "conflict", "invalid_ref", "snapshot_refused", "unknown"]>` and the type            | The closed reason vocabulary.                                                                                            |
| `JjError`             | `class JjError` with `_tag` `"@smthrs/jj/JjError"`                                                                     | A jj failure, shaped after `effect/PlatformError`.                                                                       |
| `jjError(options)`    | `(options: { code: JjErrorCode; module?: string; method: string; description?: string; command?: string }) => JjError` | Composes the human message from the code, the failing `module.method`, and the description. `module` defaults to `"Jj"`. |
| `isJjError(error)`    | `(error: unknown) => error is JjError`                                                                                 | Tells "jj said no" from "the capability kernel said no" without matching `_tag` by hand.                                 |
| `JjFailure`           | `type JjFailure = JjError \| Permission.PermissionError`                                                               | Everything a `Jj` operation can fail with.                                                                               |
| `JjErrorCause`        | `Schema.Struct<{ name?: string; code?: string; message: string }>` and the type                                        | The plain-data projection of an underlying host failure.                                                                 |
| `jjErrorCause(cause)` | `(cause: unknown) => JjErrorCause`                                                                                     | Projects an arbitrary host failure onto that shape, truncating each field to fit.                                        |
| `causeMessageLimit`   | `1024`                                                                                                                 | How many characters each string in a `JjErrorCause` keeps.                                                               |

`JjError` carries a stable `code`, the `module` and `method` that failed, a
human `message`, the `command` that produced it, and an optional `cause`.

The codes are a stable public contract: callers branch on them, step keys
digest them, and user interfaces map them to remediation, so a code is added
and never repurposed. `not_installed` means no usable jj on this host,
`conflict` that the repository refused because the operation would conflict,
`invalid_ref` that the change id or revision does not resolve, and `unknown`
everything else jj reported. Both adapters classify onto the same four, and
[test/LayerParity.test.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/jj/test/LayerParity.test.ts)
drives one table of inputs through both and asserts they agree.

`cause` is a projection, not the host failure itself. `JjError` round-trips
through the journal, and an `Error` serializes to `{}` because its `message` and
`stack` are not enumerable, so the underlying failure is copied onto the three
fields of `JjErrorCause` (`name`, `code`, `message`) at construction. The schema
bounds every field by `causeMessageLimit`. The `JjError` constructor and the
journal decoder reject an over-length field; `jjErrorCause` is the supported
projection and truncates each field to fit.

## Implementations

Implementations are **not** root exports. The root is the portable contract and
bundles for the browser; each implementation is imported from its own subpath.

### @smthrs/jj/node/NodeJj

`NodeJj` shells out to the `jj` CLI with argv arrays and never a shell string.
It ships four layers, and they differ along two axes.

| Export                           | Signature                                                           | Process ownership | Repository      |
| -------------------------------- | ------------------------------------------------------------------- | ----------------- | --------------- |
| `layer`                          | `Layer<Jj>`                                                         | Its own child     | The process cwd |
| `layerAt(repositoryRoot)`        | `(repositoryRoot: string) => Layer<Jj>`                             | Its own child     | Bound, absolute |
| `layerSpawner`                   | `Layer<Jj, never, ChildProcessSpawner>`                             | The host spawner  | The process cwd |
| `layerSpawnerAt(repositoryRoot)` | `(repositoryRoot: string) => Layer<Jj, never, ChildProcessSpawner>` | The host spawner  | Bound, absolute |

Who owns the child process: `layer` spawns through `node:child_process`
directly, because a host must be able to checkpoint work where a spawner is
unavailable, sandboxed, or gated behind a `proc:spawn` grant the user has not
given. `layerSpawner` spawns through Effect's `ChildProcessSpawner`, so whatever
decorates that service decorates jj too: the child lands in a recorded process
group, in `@smthrs/kernel`'s `ProcessLedger`, and within reach of the reaper
that sweeps a crashed incarnation. `@smthrs/platform-node`'s contained host
bundle uses that one. Both share one command vocabulary and one classification,
so routing jj through a spawner changes nothing a caller can observe.

Which repository: `layerAt` and `layerSpawnerAt` bind jj to one absolute
repository root, so a later change to `process.cwd()` cannot redirect snapshots,
restores, or diffs into another checkout. A relative `path` handed to
`workspaceAdd` then resolves against that root rather than the caller's working
directory, so pass absolute lane paths. `root(from)` is exempt from the binding
by design, because its argument names the directory jj must run in. A relative
root is a wiring mistake and throws a `TypeError` at construction.

Node and Bun `snapshot(message)` first close the current change, then describe
that closed change only if it was unnamed. Existing operator descriptions are
preserved; the fresh working copy remains unnamed. Without a message, no
`describe` or editor runs. The browser's frozen WASM ABI still replaces the
closed change's description when a message is supplied.

Repository state operations are fenced as a unit. `snapshot`, `restore`, and
`diff` share one single-permit semaphore per repository inside a process and an
exclusive `.jj/smithers.lock` owner directory across processes. The snapshot's
CLI calls therefore cannot interleave with another state operation. A caller
reclaims a lock whose owner process has exited, so an abruptly killed host does
not strand the repository.

Node and Bun snapshots disable jj's default new-file size limit with
`--config snapshot.max-new-file-size=0`, so new artifacts larger than 1 MiB are
included. Any command that still warns `Refused to snapshot some files` fails
with `JjError.code = "snapshot_refused"`, even when jj exits successfully.

One invocation buffers at most 64 MiB of each output stream, counted in bytes as
they arrive rather than in decoded characters, and past the ceiling the child is
killed and the operation fails `unknown`. The `command` recorded on a failure is
the argv rendered back as a typed line, capped at 512 characters. Both layers
apply both bounds.

A spawn that never produced a process is still a `JjError`.
`node:child_process` throws rather than emitting an `error` event for most
failures, so the adapter guards the construction, and it probes the working
directory before blaming the binary: a bound layer pointed at a directory that
is gone reports the directory rather than claiming jj is not installed.

### @smthrs/jj/bun/BunJj

Bun implements the same child-process API, so `BunJj` re-exports all four Node
layers rather than shipping a second implementation. Sharing the adapter is what
keeps the two runtimes from drifting.

| Export           | Same object as          |
| ---------------- | ----------------------- |
| `layer`          | `NodeJj.layer`          |
| `layerAt`        | `NodeJj.layerAt`        |
| `layerSpawner`   | `NodeJj.layerSpawner`   |
| `layerSpawnerAt` | `NodeJj.layerSpawnerAt` |

### @smthrs/jj/node/resolveJjBinary

Decides which file `jj` is, and explains the answer.

| Export                            | Signature                                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveJjBinary(options?)`       | `(options?: Options) => Resolved`                                                                                                                                         |
| `describe(resolved)`              | `(resolved: Resolved) => string`                                                                                                                                          |
| `overrideVariables`               | `ReadonlyArray<string>`, currently `["SMITHERS_JJ_PATH"]`                                                                                                                 |
| `isExecutable(file, options?)`    | `(file: string, options?: { platform?: NodeJS.Platform; access?: (file: string, mode: number) => void }) => boolean`                                                      |
| `permissionHint(file, platform?)` | `(file: string, platform?: NodeJS.Platform) => string`                                                                                                                    |
| `shellQuote(value)`               | `(value: string) => string`                                                                                                                                               |
| `Source`                          | `type Source = "env" \| "path"`                                                                                                                                           |
| `Resolved`                        | `interface { path: string; source: Source; executable: boolean; hint?: string; variable?: string; ignored?: { variable: string; path: string } }`                         |
| `Options`                         | `interface { environment?: Record<string, string \| undefined>; platform?: NodeJS.Platform; exists?: (file: string) => boolean; executable?: (file: string) => boolean }` |

`SMITHERS_JJ_PATH` names the binary the adapter spawns. An override that names
an existing file stays authoritative even when it cannot be executed, so a
broken explicit path is reported instead of a different binary being quietly
substituted. An override that names nothing falls through to `PATH`, and the
fall-through is reported in `describe()` rather than passing silently. A
resolution that came from `PATH` is spawned as the bare name `jj`, so a host
spawner that hands the child a different `PATH` still decides for itself.
`smthrs doctor` prints `describe()`.

`resolveJjBinary` always returns a command: when jj is genuinely absent it
answers the bare name `jj` with `executable: false` and a hint, which keeps
every caller's soft-failure behavior while giving `doctor` something specific
to print. rc.0 vendors no `jj` platform packages, so there is no bundled branch.

Every probe in `Options` is injectable, so a test pins the resolution order
without staging a filesystem. `isExecutable` checks the execute bit on POSIX and
mere existence on Windows; it is a probe and never a `chmod`. `permissionHint`
adds the macOS quarantine tip only on darwin, and quotes the path with
`shellQuote`, because the hint is remediation an operator pastes into a shell.

### @smthrs/jj/browser/BrowserJj

jj is a native binary, but jj-lib compiles to `wasm32-wasip1`.
`BrowserJj.layer({ fs, wasm })` runs the `flows_jj.wasm` reactor shipped at this
package's `wasm/flows_jj.wasm` over an injected virtual filesystem, through the
hand-written WASI preview 1 shim in this package. The mount and the compiled
module are arguments rather than dependencies, so the library never picks a
storage backend for its host, and persistence stays the page's concern.

| Export             | Signature                                  |
| ------------------ | ------------------------------------------ |
| `make(options)`    | `(options: BrowserJjOptions) => Jj`        |
| `layer(options)`   | `(options: BrowserJjOptions) => Layer<Jj>` |
| `layerUnsupported` | `Layer<Jj>`                                |
| `BrowserJjOptions` | `interface` (below)                        |

| `BrowserJjOptions` field | Type                                 | Meaning                                                            |
| ------------------------ | ------------------------------------ | ------------------------------------------------------------------ |
| `wasm`                   | `WebAssembly.Module \| BufferSource` | The reactor, precompiled or as raw bytes. The layer never fetches. |
| `fs`                     | `SyncFsLike`                         | The synchronous filesystem the repository lives on.                |
| `root`                   | `string`, default `"/"`              | The workspace root inside that namespace.                          |
| `onStdout`               | `(text: string) => void`             | Receives jj-lib's stdout. Unset drops it.                          |
| `onStderr`               | `(text: string) => void`             | Receives jj-lib's stderr, where Rust panics arrive.                |

`root`, `fs`, `onStdout`, and `onStderr` are read once, when `make` is called.
`wasm` is read once too, but later, at the first operation, which is what lets a
page hand over bytes it is still loading. Raw bytes are copied at that read, so
the executable authority cannot be swapped between a failed operation and a
retry. Instantiation is lazy, and every operation runs under a single-permit
semaphore, because the wasm instance is single-threaded mutable state.

`BrowserJj.layerUnsupported` is the layer for a host that ships no module. Every
operation reports `not_installed`, the same code the Node adapter reports for a
missing binary, so a caller needs no browser-specific branch. The command each
failure names is the one `NodeJj` would have run.

Two places where the browser backend answers differently from the CLI, both
because the frozen wasm ABI has no field for them:

- `workspaceAdd` with a revision is two calls, an add followed by a restore
  rooted at the new lane. The whole sequence runs uninterruptibly. If the pin
  fails, the adapter attempts a `workspaceForget` and reports the pin failure
  against `workspaceAdd`. A successful rollback frees the lane name but leaves
  the lane directory on disk, which is what `workspaceForget` does everywhere.
  If the rollback itself fails, the lane can stay registered. The caller still
  receives the pin failure, which is the one it can act on. Only a single ABI
  operation can make the pair atomic; the CLI adapter's single command needs no
  rollback.
- `root(from)` answers the configured slice root, and fails when `from` is not
  inside it rather than answering for an unrelated tree.

Every other divergence, including auto-initialization and symlink degradation,
is in [Run jj in a browser tab](./guides/run-jj-in-a-browser.md#where-the-wasm-backend-answers-differently).

### @smthrs/jj/browser/WasiPreview1

The syscall layer under the wasm build of jj, public because it is testable
without any wasm module: `make` returns plain functions over memory, a
filesystem, and a file-descriptor table.

| Export                | Signature                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `make(options)`       | `(options: WasiPreview1Options) => WasiPreview1`                                                                           |
| `Errno`               | A frozen record of WASI preview 1 errno names to numbers.                                                                  |
| `WasiExitError`       | `class WasiExitError extends Error` with `readonly exitCode: number`                                                       |
| `WasiPreview1Options` | `interface { fs: SyncFsLike; root?: string; onStdout?: (text: string) => void; onStderr?: (text: string) => void }`        |
| `WasiPreview1`        | `interface { imports: Record<string, (...args: Array<any>) => number>; initialize: (memory: WebAssembly.Memory) => void }` |

Instantiate the module with `{ wasi_snapshot_preview1: shim.imports }`, then
call `initialize(memory)` before the module's `_initialize` runs, because
`_initialize` may already issue syscalls. One preopen is exposed: fd 3 names
`"/"`, mapped to `root` in the slice.

`Errno` is exported so tests assert numbers against spec names rather than magic
literals. `WasiExitError` is what a `proc_exit` from a reactor module becomes: a
thrown error that traps the calling export, which `BrowserJj` reports as a
failed operation.

The `root` option confines the guest to one slice of the backing filesystem.
`..` of the namespace root is the root, and every symlink is resolved in
namespace coordinates rather than handed to the backend: an absolute link target
is re-rooted at the preopen, a relative one is clamped against the link's own
directory, and intermediate components are resolved too, so a link naming a
directory cannot smuggle the rest of a path out of the slice. A chain that does
not terminate within the hop budget is `ELOOP`.

Honest divergences from a kernel WASI host, documented rather than hidden:

- `fd_sync` and `fd_datasync` are no-ops, because a synchronous slice is durable
  the moment each call returns.
- `poll_oneoff` reports every subscription complete immediately: clock waits
  become yields, and a synchronous filesystem is always ready.
- `path_link` is `notsup`: the slice has no `linkSync`, and the jj code paths
  this package exercises never hard-link.
- `path_filestat_set_times` always follows symlinks, because the slice has no
  `lutimesSync`.
- `fd_readdir` re-lists the directory on each call and uses the entry index as
  the cookie, so a directory mutated between two reads of one iteration can skip
  or repeat a name. That is unobservable from the single-threaded module this
  shim hosts.
- A directory file descriptor names a path, not an inode. Renaming the directory
  a descriptor was opened on makes the descriptor follow the name, where POSIX
  would keep naming the moved directory. Remembering the host path at open time
  would be worse than a divergence: a symlink left at the old name would then be
  followed out of the preopen.
- `sock_*` and `proc_raise` are `notsup`; there are no sockets or signals in a
  tab.

### @smthrs/jj/browser/WasiFs

Names the synchronous filesystem shape the shim runs over, and imports nothing,
so the browser bundle decides which backend is mounted.

| Export           | Meaning                                                                                                                                                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SyncFsLike`     | The filesystem surface: `openSync`, `closeSync`, `readSync`, `writeSync`, `fstatSync`, `ftruncateSync`, `futimesSync`, `statSync`, `lstatSync`, `mkdirSync`, `readdirSync`, `renameSync`, `unlinkSync`, `rmdirSync`, `readlinkSync`, `symlinkSync`, `utimesSync`, `truncateSync`. |
| `SyncStatsLike`  | The `Stats` subset the shim reads: `size`, `atimeMs`, `mtimeMs`, `ctimeMs`, optional `ino`, and the three `is*` predicates.                                                                                                                                                       |
| `SyncDirentLike` | The `Dirent` subset `fd_readdir` needs: `name` and the three `is*` predicates.                                                                                                                                                                                                    |

Both ZenFS's sync API and Node's `node:fs` satisfy the shape structurally. Two
deliberate consequences: `openSync` takes Node string flags (`"r"`, `"r+"`,
`"w"`, `"wx"`) rather than numeric `O_*` constants, which are platform specific
and live on a module this slice refuses to import; and errors must be thrown
with a Node-style string `code` property (`"ENOENT"`, `"EEXIST"`, `"ENOTDIR"`),
which the shim maps onto WASI errno values.

There is deliberately no `fsyncSync`: a synchronous backend is durable the
moment a call returns. `ftruncateSync` and `futimesSync` are required, because
the descriptor-addressed WASI calls must follow the open file even after a
rename, which is the shape of jj's tempfile-persist path.

## Durable identity

The tag key `@smthrs/jj/Jj` and the error `_tag` `@smthrs/jj/JjError` are
durable identity: step keys digest the resolved service set, and `JjError`
round-trips through the journal, so renaming either invalidates recorded runs.
[test/index.test.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/jj/test/index.test.ts)
pins both. See [Content addressing](/docs/concepts/content-addressing/).

## Browser support

`@smthrs/jj` and `@smthrs/jj/browser/BrowserJj` are gated as browser entry
points by `scripts/browser-check.mjs` (`pnpm run browser`, and one CI step). The
same gate asserts that `@smthrs/jj/node/NodeJj` and `@smthrs/jj/bun/BunJj` still
do **not** bundle, and that the reason is `node:child_process`.

## Reading next

[`@smthrs/kernel`](/api/kernel) owns the closed service list and decorates `Jj`
with capability checks, and [`@smthrs/time-travel`](/api/time-travel) uses it for
workspace snapshot and restore. See also
[Capabilities and the host kernel](/docs/concepts/kernel/) and
[Time travel](/docs/concepts/time-travel/).
