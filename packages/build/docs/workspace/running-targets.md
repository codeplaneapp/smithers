# Running targets

A verb selects targets, plans their transitive dependency closure, and executes
it. Targets carry no per-command shell scripts.

```sh
smithers-build install --workspace .
smithers-build build //packages/...
smithers-build test //packages/flow:test
smithers-build lint //packages/flow:lint
smithers-build docs //...
smithers-build run //:newPackage --name @scope/widget
smithers-build ci //...
```

For every flag, output field, and exit code, see
[the CLI reference](../reference/cli.md).

## Verb selection

Each target declares its `kinds`. A verb selects matching roots and always adds
their dependencies, regardless of the dependencies' own kinds.

| Verb      | Root selection                          | Executes             |
| --------- | --------------------------------------- | -------------------- |
| `build`   | kind includes `build`                   | Yes, unless `--plan` |
| `test`    | kind includes `test`                    | Yes, unless `--plan` |
| `lint`    | kind includes `lint`                    | Yes, unless `--plan` |
| `docs`    | kind includes `docs`                    | Yes, unless `--plan` |
| `run`     | kind includes `run`                     | Yes, unless `--plan` |
| `ci`      | lint, build, and test plans, merged     | Yes, unless `--plan` |
| `install` | the `Install` flow, not a label pattern | Yes                  |
| `query`   | every target the expression matches     | No                   |
| `graph`   | every target the pattern matches        | No                   |

An exact label that does not participate in the requested verb fails with
`target selected by <pattern> does not support the <verb> verb`. A recursive
pattern that selects nothing for one verb returns an empty graph. `ci` tolerates
a per-kind refusal as long as at least one of lint, build, or test accepts the
pattern.

`run` is intentionally outside `ci`: it selects operational targets such as
cleaning, watch processes, source generation, and release actions. `docs` is an
on-demand documentation gate and is also outside `ci`.

## What executes

The executor gives each target its own in-memory runtime and provides:

- pnpm install actions;
- process execution and output capture;
- filegroup expansion and declared-output verification;
- generated-file writes/checks and package-manifest synchronization;
- GitHub workflow and documentation checks;
- LLM review and package scaffolding.

The irreversible-exec implementation is intentionally absent. A target that
calls it fails at interpretation with `unresolved_action`.

| Target                                                         | Root verb       | Executes today                                            |
| -------------------------------------------------------------- | --------------- | --------------------------------------------------------- |
| `TsBuild`, `DtsBuild`, `Typecheck`, `ToolBuild`, `TypedocDocs` | `build`         | Yes                                                       |
| `Vitest`, `VitestCoverage`                                     | `test`          | Yes                                                       |
| `EsLint`, `BiomeCheck`, `DepsLint`, `PackageLint`, `LlmLint`   | `lint`          | Yes                                                       |
| `SortPackageJson`                                              | `build`, `lint` | Yes                                                       |
| `PackageJsonCheck`                                             | `lint`          | Yes                                                       |
| `PackageJsonWrite`, `PackageJsonRefresh`                       | `run`           | Yes; mutates the source manifest                          |
| `GithubCiGen`                                                  | `build`, `lint` | Yes; CI selects its checking form                         |
| `DocsParity`                                                   | `docs`          | Yes                                                       |
| `NewPackage`                                                   | `run`           | Yes; requires `--name` and creates a package              |
| `PnpmWorkspace`                                                | `run`           | Yes                                                       |
| `Clean`, `Dev`, `VitestWatch`                                  | `run`           | Yes; the watch processes hold their execution slot        |
| `Changesets`                                                   | `run`           | `status` yes; `version` lacks the irreversible-exec layer |
| `NpmPublish`, `JsrPublish`                                     | `run`           | No; both require the absent irreversible-exec layer       |

An `LlmLint` target now runs through `LlmReviewLive`; it is no longer a
plan-only declaration. Release mutations remain separately gated.

## Verb-effective attributes

A target that declares several kinds may execute a different form under each one.
`GithubCiGen` maps `lint` to drift checking. Package manifests use distinct
check, write, and refresh targets.

The planner resolves attributes, declared inputs, cacheability, and therefore
content keys per verb. `ci` plans lint first, then build and test, and keeps the
first occurrence when merging by label. A generator shared by build and lint
therefore contributes its non-mutating check form to CI.

See [Verb-effective attrs](../concepts/targets.md#verb-effective-attrs).

## Execution semantics

- **Order and concurrency.** Dependencies precede dependents. At most `--jobs`
  targets run at once; the default is host available parallelism. Invalid job
  counts are refused.
- **Keep going.** A failed target blocks only its dependent cone. Unrelated
  targets continue. An internal scheduler fault stops new dispatch and waits
  for work already in flight.
- **Cache.** A cacheable target consults its content key. A validated green hit
  skips execution; a validated green run is stored. `--no-cache` bypasses reads
  and still writes.
- **Input stability.** Declared inputs are re-expanded before cache admission
  and after execution. A changed path set or digest fails the target under the
  original plan rather than publishing stale work.
- **Output integrity.** Declared outputs must exist and match the returned
  manifest before either a run or a cache hit is reported green.
- **Working directory.** The process-wide `cwd` is never changed. Every action
  resolves and validates its own directory under the canonical workspace root.
- **Runtime isolation.** Each target gets a fresh runtime because targets made
  from one target share a flow tag.

## Output

One line per settled target goes to standard error, followed by a summary:

```text
//packages/flow:lib  hit  2ms
//packages/engine:lib  ran  3.1s
//packages/engine:test  failed  0.4s  {"_tag":"smithers-build/ExecError", ...}
//packages/app:lib  skipped  0ms  dependency //packages/engine:test did not succeed
4 targets: 1 hit, 1 ran, 1 failed, 1 skipped (3.6s)
```

The structured result on standard output reports the verb, pattern, jobs,
duration, counts, verdict, and one report per target.

## Planning only

`--plan` prints the inert dependency-first plan, expanded declared inputs, key
material, and SHA-256 content key without executing. `query` and `graph` are
always non-executing.

```sh
smithers-build build //... --plan
smithers-build docs //... --plan
smithers-build run //:clean --plan
smithers-build ci //... --plan
```

The planner does not consult the cache, so its `cacheLookup` remains
`"not-wired"` and `wouldRun` remains `true`; the executor performs the real
lookup.

## Installing dependencies

`smithers-build install` takes no label. It executes the one-round install flow
under the pnpm layer and returns the canonical workspace, manager, recorded
nodes, and link manifest.

The declared store is fixed at `.flows/store/pnpm`. If `--cache-dir` or the
root `Workspace` declaration selects another directory, install refuses rather
than declaring one path and writing another. Other verbs support custom cache
directories.

See [Install](../concepts/install.md).

## Next

- [Querying](querying.md)
- [Caching](caching.md)
- [CLI reference](../reference/cli.md)
