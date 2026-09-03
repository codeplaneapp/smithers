# Actions and boundaries

A target body records plan nodes. The nodes that touch the world are **action
calls**. An action is a declaration: a payload schema, a success schema, an error
schema, a tier, and an effects annotation. Its implementation attaches separately
as a layer.

## Tiers

| Tier           | Meaning                                                              |
| -------------- | -------------------------------------------------------------------- |
| `sealed`       | Content-keyable. The plan compiler accepts it.                       |
| `compensable`  | Requires compensation on retry.                                      |
| `irreversible` | Must never be retried blindly, replayed, or run to populate a cache. |

`StepKey.fromKeyMaterial` fails with `non_content_material` for `compensable` and
`irreversible` material, and `Plan.compile` keys every node, so a single
non-sealed action makes a flow unplannable. Every action in the `Install` flow is
therefore `sealed`, including link, which the design would otherwise declare
`compensable`.

`ExecIrreversible` is the exception, and it is not part of a plannable install
flow. The release targets use it for runs that mutate manifests or external
registries.

## Boundary modes

An action's effects annotation declares what it reads, what it writes, and its
boundary mode.

| Mode       | Meaning                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------- |
| `hard`     | The declared read and write set is the complete set.                                        |
| `expected` | The declared set is what the action expects; an observed deviation is recorded, not failed. |

`ActionPersistence` admits a result to the cross-run cache only when the tier is
`sealed` **and** the boundary mode is `hard`. Boundary mode, not tier, is what
keeps a result out of the shared cache.

## The install boundaries

| Action                                   | Tier     | Boundary   | Reads                              | Writes                                     | Cache-admissible |
| ---------------------------------------- | -------- | ---------- | ---------------------------------- | ------------------------------------------ | ---------------- |
| `smithers-build/install/measure`         | `sealed` | `expected` | `.npmrc`, every supported lockfile | none                                       | No               |
| `smithers-build/install/fetch/{manager}` | `sealed` | `expected` | the manager's lockfile, `.npmrc`   | `TreeArtifact` at `.flows/store/<manager>` | No               |
| `smithers-build/install/link`            | `sealed` | `expected` | `package.json`                     | none                                       | No               |

Fetch is shaped as the potentially shareable half, but it is not shared today.
The absolute-root package-manager process can open the lockfile and `.npmrc`
after the parent verifies them, and the current observer cannot freeze those
paths or prove there were no undeclared effects. Calling that boundary `hard`
would be a false hermeticity claim.

Measure is not admissible because it reports the host's package-manager version,
which no declared read set covers. A restored measurement would carry the version
of whichever machine recorded it first into every downstream key.

Link is not admissible because a `node_modules` tree is a graph of links into a
local store. Restoring one from another machine would produce a tree pointing at
nothing. Link declares no write on purpose: the current boundary contract turns
every declared write into materialized artifact evidence, so naming
`node_modules` would cache the tree it is forbidden to cache.

## The shared exec action

Catalog targets do not declare their own actions. They call one shared action,
`smithers-build/exec`, declared `sealed`.

```ts
Payload = {
  cwd: string                        // resolved against the workspace root
  argv: NonEmptyArray<string>        // argv[0] is the executable
  env: Record<string, string>        // merged over process.env, default {}
  expectedExitCodes: Array<number>   // default [0]
  after?: unknown                    // an upstream planned result, for ordering
}

Result = { exitCode: number, stdout: string, stderr: string, durationMs: number }
```

`ExecLive` implements it with `node:child_process.spawn`. Never through a shell.
Killing the fiber kills the child. `stdout` and `stderr` are truncated to 200 KiB;
an `ExecError`'s `stderr` carries the last 8 KiB, or the spawn error message when
nothing ran and `exitCode` is `-1`.

Each stream is decoded by its own streaming UTF-8 decoder, so a code point whose
bytes land in two pipe chunks decodes once and correctly. Decoding each chunk on
its own made captured output depend on where the kernel happened to break the
pipe, which made one command's result differ between runs and from its own cache
entry. Both bounds are counted in UTF-16 code units, and neither the head nor the
tail is ever cut between the halves of an astral code point.

The run settles exactly once. A failed spawn emits `error` and then `close`, a
pipe can fail alongside either, and only the first of them answers; the rest are
dropped with the listeners. A tool the kernel killed is always a failure, and the
signal is named in the diagnostic rather than flattened into `exitCode` `-1`. A
pipe that fails mid-run fails the target instead of reporting the truncated text
it managed to capture.

The child is spawned detached, so interrupting the fiber signals its whole
process group and takes its children with it. Windows has no process groups: the
fallback there terminates the child alone, and a grandchild it started outlives
the kill. No Node API changes that.

`after` carries no data to the spawn. It exists so an upstream step is a material
dependency the engine settles first. Without it, two keyless exec steps dispatch
at once and the engine refuses with `ConcurrentKeylessDispatch`.

## The other actions

| Action group                                    | Tier           | Provided by the CLI executor |
| ----------------------------------------------- | -------------- | ---------------------------- |
| `exec`, `capture-outputs`, `filegroup`          | `sealed`       | Yes                          |
| `write-file`, `check-file`, `sync-package-json` | `sealed`       | Yes                          |
| `check-workflow`, `check-docs`, `llm-review`    | `sealed`       | Yes                          |
| `scaffold-package`, `not-implemented`           | `sealed`       | Yes                          |
| `smithers-build/install/*`                      | `sealed`       | Yes, under pnpm              |
| `smithers-build/exec-irreversible`              | `irreversible` | No                           |

The ordinary implementations are re-exported from the `@smthrs/targets` package
root. `ExecIrreversibleLive` remains an explicit opt-in from the Changesets
module and is intentionally absent from the normal executor.

An action call with no implementation in scope is a wiring error, not a runtime
contingency. The interpreter refuses with `unresolved_action` before it runs
anything. See [Running targets](../workspace/running-targets.md#what-executes).

## Host state never reaches a payload

The resolved cache directory is host state: it names where one machine keeps
replayable files, so two checkouts that configured it differently must still
agree on every key.

`DepsLint` needs to write a generated knip config into that directory. It emits
the constant token `{smthrs:cache-directory}` in its argv at plan time.
`ExecLive` validates the host directory and substitutes it into every argument
immediately before spawn. The real path therefore never enters an action payload
or a step key.

## Hermeticity

Every tool run goes through one sandbox module, `ExecSandbox`, and every
declared confinement is enforced or the target fails closed. Nothing logs
"unenforced" and carries on.

A target declares a policy: the default confinement, `{ network: "loopback" }`,
`{ network: true }`, or the `"none"` opt-out. On the `PACKAGE.ts` surface
that is the `sandbox` attr and the default is the confinement. On the
`PACKAGE.ts` surface the root `Workspace({ sandbox })` declaration sets one
policy for every tool-running target, and the default is `"none"` until a
workspace declares otherwise, because the catalog's declared inputs are what
the sandbox exposes and a workspace has to declare them completely first.

Under confinement a tool may read its declared read set and nothing else under
the workspace: the target's expanded declared inputs, the outputs of every
transitive dependency, the `node_modules` trees above its working directory,
and the cache directory's scratch and fetch store. It may write its declared
outputs, its declared `changes`, and the cache directory with the result cache
itself re-closed, plus a private temporary directory and home. A declared
output file opens the directory it lives in, because a file cannot be bound
before it exists and a tool that writes by rename needs the directory. The
network is closed unless the policy opens it.

| Host    | Mechanism                                                                                                                                                                                                                                                                              |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux   | bubblewrap. The host root is bound read-only, a tmpfs covers the workspace, the declared set is bound on top, the tmpfs is remounted read-only, and the network namespace is unshared. `loopback` shares the host network, because a namespace cannot admit the host's loopback alone. |
| macOS   | seatbelt. Reads under the workspace are denied except the declared set, writes are denied except the declared set and the private tmp, and the network is denied except what the policy opens. The operating system and toolchain outside the workspace stay readable.                 |
| Docker  | `docker run` with a read-only root, the declared set mounted at its host paths, and `--network none`. Declared with `S.Sandboxes({ default: S.Sandbox.Docker({ image }) })`; the image supplies the toolchain. The only mechanism on Windows.                                          |
| Windows | Nothing native. A confined target without a Docker declaration fails closed.                                                                                                                                                                                                           |

The mechanism is selected per host: bubblewrap on Linux, seatbelt on macOS,
Docker where declared. A Linux host without `bwrap`, a Windows host without
a Docker declaration, or a declared mechanism missing from `PATH` fails the
target with `sandbox_unenforceable` and a message naming what is missing.
`--plan` reports the answer as `sandboxEnforced`.

An undeclared read is missing or refused, an undeclared write fails at the
kernel, and the run fails. The sandbox denies at the kernel, so the witness is
the tool's own error text; the failure carries the paths that text names and
which side of the boundary each fell on:

```text
/bin/sh: note.txt: Operation not permitted
sandbox: note.txt is outside the declared write set
sandbox: seatbelt, network none, 3 read path(s), 2 write path(s)
```

Reads outside the workspace are not scoped on any mechanism. The workspace
tree is what the content key covers; the loader, the interpreters, and the
package manager live outside it, and the toolchain identity that names them is
the `nix:<hash>` layer of a declared [Nix environment](environments.md).

A `PACKAGE.ts` file is not sandboxed, and it is not meant to be. It is
executable TypeScript evaluated in the CLI process: it can import any host
module, read any file you can read, and spawn any process. Evaluating a
workspace is exactly as trusted as running that repository's own code. The CLI
does not empty `process.env` around the evaluation, because a module that wants
the environment can read it another way and emptying a process-global would
corrupt any concurrent caller. What the CLI does guarantee is narrower and
real: token values never enter a declaration, a target key, or a stored cache
entry, and the child-process environment is where the credential is withheld.

A result produced outside an enforced confinement stays in the local cache
tier. Only a confined run publishes to the shared tier; see
[Remote caching](../workspace/remote-caching.md#the-current-engine-boundary).

## Next

- [Install](install.md)
- [Writing targets](../extending/writing-targets.md)
- [Remote caching](../workspace/remote-caching.md)
