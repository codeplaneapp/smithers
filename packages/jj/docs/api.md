One program, three layers. The body never changes; the import at the top decides
which adapter runs it.

:::code-group

```ts [Node]
import { Jj } from "@smthrs/jj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const jj = yield* Jj
  return yield* jj.snapshot("before the step")
}).pipe(Effect.provide(NodeJj.layer))
```

```ts [Bun]
import { Jj } from "@smthrs/jj"
import * as BunJj from "@smthrs/jj/bun/BunJj"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const jj = yield* Jj
  return yield* jj.snapshot("before the step")
}).pipe(Effect.provide(BunJj.layer))
```

```ts [Browser]
import { Jj } from "@smthrs/jj"
import * as BrowserJj from "@smthrs/jj/browser/BrowserJj"
import * as Effect from "effect/Effect"

const makeProgram = (options: BrowserJj.BrowserJjOptions) =>
  Effect.gen(function*() {
    const jj = yield* Jj
    return yield* jj.snapshot("before the step")
  }).pipe(Effect.provide(BrowserJj.layer(options)))
```

:::

The package root holds the contract, its error, and the no-op layer only, so it
bundles for the browser. Implementations live under `/node`, `/bun`, and
`/browser`. The package depends on `effect` and `@smthrs/capability` (its error
channel names `Permission.PermissionError`); [`@smthrs/kernel`](/api/kernel)
depends on it, because `Jj` is one of the tags in the closed host list.

## The contract

`Jj` is deliberately small: only the operations that make a step reversible.
`snapshot`, `restore`, `diff`, `workspaceAdd`, `workspaceForget`, and `status`
are required of every backend. `root` and `revert` are optional on the TYPE, so
a hand-written test double may leave them out.

Every layer this package ships defines both anyway, and answers `not_installed`
in the error channel where the backend cannot perform them. **Feature detection
is by error code, never by property absence**: `"revert" in jj` is true for
`makeNoop`, for `BrowserJj.make`, and for `BrowserJj.layerUnsupported` alike, so
a caller that needs to know asks and reads the code it gets back. An absent
capability is a capability with an answer.

`snapshot` describes the current change, reads its id, and opens a fresh one:
the id returned is the state a later `restore` goes back to. With no message
there is no `describe` at all, because `jj describe` without `-m` starts
`$JJ_EDITOR` and waits for it.

`restore` and `revert` exist because one cannot express the other. `restore`
moves the working copy back to a recorded point, which discards everything
committed after it. `revert` undoes ONE change and keeps the rest, which is what
an operator means by "undo that attempt", and it reports the paths it touched so
the caller can say what was undone. `root` answers `jj root`, which is correct
for colocated repositories and secondary workspaces that a walk up looking for
`.jj` would get wrong.

Both optional operations are capability-checked like every other one:
`jj:root` is `sealed` and `jj:revert` is `compensable`.

### Failures

`JjError` carries a stable `code`, the `module` and `method` that failed, a
human `message`, the `command` that produced it, and an optional `cause`.

The codes are a closed public contract: `not_installed`, `conflict`,
`invalid_ref`, and `unknown`. Callers branch on them, step keys digest them, and
UIs map them to remediation, so a code is added and never repurposed. Both
adapters classify onto the same four, and
[packages/jj/test/LayerParity.test.ts](https://github.com/smithersai/smithers/blob/main/packages/jj/test/LayerParity.test.ts)
drives one table of inputs through both and asserts they agree.

`cause` is a projection, not the host failure itself. `JjError` round-trips
through the journal, and an `Error` serializes to `{}` because its `message` and
`stack` are not enumerable, so the underlying failure is copied onto the three
fields of `JjErrorCause` (`name`, `code`, `message`) at construction, with the
message bounded by `causeMessageLimit`.

## Implementations

Implementations are **not** root exports. The root is the portable contract and
bundles for the browser; each implementation is imported from its own subpath.

### Node and Bun

`NodeJj` shells out to the `jj` CLI with argv arrays and never a shell string.
It ships four layers, and they differ along two axes.

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

`BunJj` re-exports all four: Bun implements the same child-process API, so
sharing the adapter is what keeps the two runtimes from drifting.

`@smthrs/jj/node/resolveJjBinary` decides which file `jj` is.
`SMITHERS_JJ_PATH` (with `FLOWS_JJ_PATH` as an rc.0 alias) names the binary the
adapter spawns, and an override that names an existing file stays authoritative
even when it cannot be executed, so a broken explicit path is reported instead
of a different binary being quietly substituted. An override that names nothing
falls through to `PATH`, and the fall-through is reported in `describe()` rather
than passing silently. A resolution that came from `PATH` is spawned as the bare
name `jj`, so a host spawner that hands the child a different `PATH` still
decides for itself. `smithers doctor` prints `describe()`.

A spawn that never produced a process is still a `JjError`. `node:child_process`
throws rather than emitting an `error` event for most failures, so the adapter
guards the construction, and it probes the working directory before blaming the
binary: a bound layer pointed at a directory that is gone reports the directory
rather than claiming jj is not installed.

### Browser

jj is a native binary, but jj-lib compiles to `wasm32-wasip1`.
`BrowserJj.layer({ fs, wasm })` runs the `flows_jj.wasm` reactor shipped at
`packages/jj/wasm/flows_jj.wasm` over an injected virtual filesystem, through
the hand-written WASI preview 1 shim in this package. The mount and the compiled
module are arguments rather than dependencies, so the library never picks a
storage backend for its host, and persistence stays the page's concern.

`BrowserJj.layerUnsupported` is the layer for a host that ships no module. Every
operation reports `not_installed`, the same code the Node adapter reports for a
missing binary, so a caller needs no browser-specific branch.

Two places where the browser backend answers differently from the CLI, both
because the frozen wasm ABI has no field for them:

- `workspaceAdd` with a revision is two calls, an add followed by a restore
  rooted at the new lane. If the pin fails, the add is rolled back with a
  `workspaceForget` and the failure is reported against `workspaceAdd`, so the
  lane name is free again and no workspace stays registered at a tree that was
  never pinned. The lane DIRECTORY is left on disk, which is what
  `workspaceForget` does everywhere; the CLI adapter's single command needs no
  rollback at all.
- `root(from)` answers the configured slice root, and fails when `from` is not
  inside it rather than answering for an unrelated tree.

`@smthrs/jj/browser/WasiPreview1` is public as well. Its `root` option confines
the guest to one slice of the backing filesystem. `..` of the namespace root is
the root, and every symlink is resolved in namespace coordinates rather than
handed to the backend: an absolute link target is re-rooted at the preopen, a
relative one is clamped against the link's own directory, and intermediate
components are resolved too, so a link naming a directory cannot smuggle the
rest of a path out of the slice. A chain that does not terminate within the hop
budget is `ELOOP`.

## Durable identity

The tag key `@smthrs/jj/Jj` and the error `_tag` `@smthrs/jj/JjError` are
durable identity: step keys digest the resolved service set, and `JjError`
round-trips through the journal, so renaming either invalidates recorded runs.
[packages/jj/test/index.test.ts](https://github.com/smithersai/smithers/blob/main/packages/jj/test/index.test.ts)
pins both. See [step keys](/concepts/step-keys).

## Browser support

`@smthrs/jj` and `@smthrs/jj/browser/BrowserJj` are gated as browser entry
points by `scripts/browser-check.mjs` (`pnpm run browser`, and one CI step). The
same gate asserts that `@smthrs/jj/node/NodeJj` and `@smthrs/jj/bun/BunJj` still
do _not_ bundle, and that the reason is `node:child_process`.

## Reading next

[`@smthrs/kernel`](/api/kernel) owns the closed service list and decorates `Jj`
with capability checks, and [`@smthrs/time-travel`](/api/time-travel) uses it for
workspace snapshot and restore. See also
[hosts and capabilities](/concepts/hosts-and-capabilities) and
[time travel](/concepts/time-travel).
