# Smithers on the Smithers factory

The Smithers monorepo declares its own build, gate, lint, and agent-lane
surface as a package-mode graph, the same surface partner repositories get.
This file records what runs, what refuses, and what the port found in the
engine underneath it.

Snapshot: branch `smthrs-dogfood`, worktree `~/smithers-smthrs-dogfood`,
forked from `84ac43ad1e` on `v1/rc0-migration`. Host: macOS 25.2.0, arm64,
node v24.18.0, pnpm 11.21.0.

## What the repository is

`git rev-list --count HEAD` reports 7,280 commits. The tree holds 52
published packages under `packages/`, seven apps, four eval suites, one Rust
crate with a vendored `jj` submodule, and a documentation site. Two regimes
share the history: the 0.x regime through 2026-08-27, and the rc.0 regime
since 2026-08-28, whose 384 commits include 274 by an author literally named
`lane <lane@local>` over three days. That number is the case for this port:
the lanes already write the code, and a human still pays for the
reconciliation after them.

## What executes today

Every command below ran from the worktree root through
`pnpm exec smithers-build`.

| Probe | Result |
| --- | --- |
| `query '//...'` | 607 labels, no refusal |
| `graph '//...'` | builds, `warnings: []` |
| `target '//workflows/wave-reconciliation:waveReconciliation' --plan` | plans, `mode: execute`, key printed |
| `target '//:ci' --plan` | plans |
| `target '//:preCommit' --plan` | plans |
| `target '//:gates' --plan` | plans |
| `target '//:agentLints' --plan` | plans, four lints |
| `target '//packages/canonical:fmt'` | green, `ran 428ms`, second run `hit 7ms` |
| `target '//packages/canonical:lint'` | green, `ran 7.2s`, second run `hit 3ms` |
| `target '//packages/canonical:check'` | green, `ran 2.2s` |
| `target '//packages/canonical:circular'` | green, `ran 909ms` |
| `target '//:knownFiles'` | green, `ran 10.8s`, second run `hit 3.2ms` |
| `target '//:preCommit'` | 343 targets, 341 ran, 1 member failed, 148.2s from cold |

`//:preCommit` is the whole repository's static gate surface: every package's
typecheck, lint, and format, plus the five root gates, plus the apps, evals,
and examples typechecks. It runs in three minutes from cold. The single failing
member is `//packages/build-cli:lint`, which this branch causes on a
case-insensitive filesystem and Linux CI does not see; see "Failure modes and
host drift".

The cache hits are the point. `//packages/canonical:lint` costs 7.2 seconds
cold and 3 milliseconds when nothing it reads has changed.

## Label inventory

`query '//...'`, counted by rule:

| Rule | Labels |
| --- | --- |
| Shell.Test | 320 |
| Filegroup | 125 |
| Suite | 77 |
| Shell.Build | 50 |
| Github.Workflow | 10 |
| Shell.Run | 5 |
| Agent.Lint | 4 |
| Agent.Diff | 4 |
| Alias | 2 |
| Generate | 2 |
| Cargo.Fetch, Cargo.Fmt, Cargo.Clippy, Cargo.Test | 1 each |
| Github.Setup, Github.CiGen, Git.Commit, Git.Pr | 1 each |

The two `Generate` labels are the repository's generated-file drift checks,
`//:knownFiles` and `//:tsconfig`.

## Judgment lints

Four, each a diff-scoped `S.Agent.Lint` over `S.Agents.reviewPool`, with the
prompt in `workflows/lints/`. Three port the `Smithers.LlmLint` targets that
`lint/BUILD.ts` already ran: `durable-identity.md`, `docs-reference-sync.md`,
`jsdoc-truthfulness.md`. The fourth, `adapter-conformance.md`, is new and
comes from the history: twelve agent adapters shipped, and the same gap set
reopened per adapter (#1622 through #1626, closed by PR #1627, with #1629
still open).

## Agent lanes

Four, each with a `SKILL.md`, a typed payload, a write set, and gates:

- `//workflows/wave-reconciliation:waveReconciliation`, the named queue. It
  is the reconciliation a human pays for after every lane wave: merge the
  lane branches, regenerate `known-files.d.ts` and the llms bundles, refresh
  both lockfiles, and gate the committed tree. Evidence: 65 merge and migrate
  commits in three days, four `merge(pack): build against the current cli-ops
  tip` commits by hand, and issue #1443, where ten hours of red main were
  fixed by hand one class at a time.
- `//workflows/effect-bump:effectBump`. The pinned Effect version is a hand
  edited constant in `scripts/check-single-effect-version.mjs`, and moving it
  touches every manifest, both lockfiles, and the release contract.
- `//workflows/new-agent-adapter:newAgentAdapter`. About one adapter a month
  plus three to five gap issues each.
- `//workflows/ci-red-triage:ciRedTriage`. 115 of 1,000 issues are CI-themed;
  the shard-3 SQLite wedge (#1549, #1577) took two fixes to close.

## Engine defects this port found

Every one refused a real target, and each carries a red-then-green test.

1. **Case-insensitive workspace probes.** `PackageDiscovery` probed for
   `WORKSPACE.ts` with `lstat`, which macOS and Windows resolve to a file
   committed as `Workspace.ts`. This repository ships
   `packages/build-cli/src/Workspace.ts`, so the CLI refused its own graph
   with `nested_workspace_undeclared` and routed into package mode from a
   source directory. Fixed by confirming the on-disk spelling with a
   directory listing. Test: `test/DiscoveryCaseInsensitive.test.ts`.
2. **Submodule gitlinks in a diff.** `git diff` reports a moved submodule
   pointer as a gitlink, which materializes as a directory and is refused for
   digestion the way a FIFO is. Every diff-scoped target in a repository that
   vendors a submodule failed with `declared input is not a regular file`.
   Both expanders now digest only the readable paths and keep the pointer in
   the key through the patch. Test: `test/GitDiffSubmodule.test.ts`.
3. **Workspace-root-only bin resolution.** `S.NodeModule.Bin` is documented
   as package local but resolved only at the workspace root. In a pnpm
   workspace a member's devDependencies link into that member's
   `node_modules/.bin`, so every per-package tool in this repository refused.
   Resolution searches the declaring package first now.
4. **No working directory on a shell target.** eslint, dprint, and vitest
   resolve their config and ignore globs against the working directory, so a
   package's own lint or format gate could not be expressed. The shared shell
   attrs take an optional workspace-relative `cwd`, the way the BUILD-era
   rules did. Test: `test/ShellCwd.test.ts`.

## Gaps and proposals, ranked

1. `DocsParity` has no package-mode executor, so the docs gate
   `PackageDefaults` synthesized for every package is unported.
2. `NewPackage` has no package-mode executor, and no Shell rule reproduces
   its dynamic `--name` input.
3. `Cron` plans but does not execute in package mode, so a scheduled lane
   cannot run.
4. Package mode has no `PackageDefaults` or macro equivalent, so the check
   surface that BUILD mode synthesized for about twenty packages is written
   out by hand, once per package.
5. The `ci`, `docs`, and `install` verbs refuse in package mode
   (`refusePackageMode`), so the generated workflows call targets directly.
6. A generated workflow cannot check its own generator for drift. Naming
   `//:githubCi` in a workflow's `run` list makes that workflow a member of
   the `CiGen` that lists it, which is a cycle the loader refuses. The
   BUILD-mode pipeline could, because its steps were verb-and-pattern strings
   rather than target references, so `lint '//:ci'` was just another step. A
   workflow step that names a plain verb and label would close this.
7. `S.Github.Workflow` has no `continueOnError`, so an advisory lane cannot
   say so. `ci-faults`, `ci-node-macos`, and `ci-node-windows` are advisory by
   convention here and would be enforcing if the repository's branch
   protection required them.
8. A declared `env` entry that names a path shadows the executor's own path
   wiring and stays relative. A `Cargo.Fetch` data edge sets `CARGO_HOME` to
   the fetch's delivery directory and registers it in `absoluteEnv`, which
   `PackageExec.ts` joins with the workspace root immediately before spawn.
   Declaring `CARGO_HOME` on the same target suppresses that, and the literal
   string reaches the child. The port's `//crates/flows-jj:wasmReproducibility`
   declared `CARGO_HOME: ".cargo-home"` and hit this. Cargo would have
   resolved the relative value against the spawn cwd and read the right
   registry, so the mistake was invisible there, but `build-wasm.mjs` turns
   `CARGO_HOME` into a `--remap-path-prefix` operand and rustc matches that
   prefix against absolute paths. The remap would have matched nothing and
   baked this machine's registry path into the artifact, failing the byte
   compare on the canonical host for a reason the message does not name. The
   declaration now omits `CARGO_HOME` and takes the wired value. Two fixes
   would close the class: resolve a declared workspace-relative path env the
   way the wired one is resolved, or refuse a relative `CARGO_HOME` rather
   than pass it through.

## The sandbox is new, and the test tier had to be declared for it

BUILD mode never sandboxed anything. `sandbox-exec` appears in exactly one
module, `packages/build-cli/src/PackageExec.ts`, which is the package-mode
executor; the BUILD-mode `Executor.ts` contains no occurrence of the string,
and neither `Vitest.Attrs` nor `NodeTest.Attrs` has a `sandbox` field to
declare. Every vitest suite in this repository therefore ran unconfined with
the host network until this port.

Package mode denies IP networking by default and permits only local unix
sockets, so the first full `//:gates` run produced 49 `listen EPERM` failures
from suites that bind a loopback port. That is new by construction, not a
regression in those suites, and the fix is a declaration: `S.Shell.Test` takes
`sandbox: { network: "loopback" }`, which permits bind, accept, and connect on
localhost with no egress (`packages/targets/src/Attr.ts` defines the union;
`PackageExec.ts` builds the profile).

Two details decide individual cases. The profile restricts IP networking only,
because it opens with `(allow default)`: the filesystem, process spawning, and
the docker socket stay reachable, so no suite needs `sandbox: "none"` for
docker, the real `jj` binary, or the keychain. And the loopback filter is
literally `local ip "localhost:*"`, which covers `127.0.0.1` and `::1` but not
a wildcard bind, so `packages/engine` needs the full opening: its
`FlowProxyServer` test uses `NodeHttpServer.layerTest`, which binds `::` with
no host.

Declaring a sandbox is key material, so annotating a target invalidates its
cache entry and re-runs that suite once.

## Failure modes and host drift

- The `vendor/jj` submodule is not initialized in this worktree, which is what
  makes `//crates/flows-jj:ci` red. `git submodule status` reports
  `-47589ada70c12b3e829b5c98ab32503abad49eac vendor/jj`, and the crate takes
  `jj-lib` as a path dependency on `vendor/jj/lib`, so cargo fails resolution
  before it compiles anything: `//crates/flows-jj:fetch` exits 101 with
  `failed to read .../vendor/jj/lib/Cargo.toml`. That one failure accounts for
  four of the seven `//:gates` failures, because `cargoClippy`, `cargoTest`,
  and `wasmReproducibility` skip behind it and `rust`, `wasm`, and `ci` go red
  as their suites. It is not a sandbox problem: the fetch declares
  `sandbox: { network: true }`, the plan carries it, `wrapSandbox` leaves a
  `network: true` argv unwrapped, and the run reaches crates.io far enough to
  print `Updating crates.io index` before the path dependency fails. The two
  targets that need no dependency resolution stay green on this host,
  confirmed under `--no-cache`: `cargoFmt` and `buildScript`.

  The operator command is
  `git submodule update --init --recursive vendor/jj`, run from
  `~/smithers-smthrs-dogfood`. It needs no network here, because
  `~/smithers/.git/modules/vendor/jj` already holds the pinned commit. It is
  still not safe to run unprompted. This tree is a linked worktree, git keeps
  one submodule gitdir per repository rather than per worktree, and that
  gitdir's `core.worktree` currently resolves to `~/smithers/vendor/jj`.
  Initializing here repoints it at this worktree and leaves the main
  checkout's `vendor/jj` detached from its gitdir until the same command runs
  there again. Running the cargo lane from `~/smithers`, which already has the
  submodule checked out at the pinned commit, avoids the question. CI has no
  such conflict: a fresh clone checks the submodule out into its own tree.

  `Git.Submodules` does execute in package mode
  (`PackageExec.ts` `implementedRules`), so the lane could declare the
  checkout as a target instead of assuming it. It stays undeclared on purpose.
  The rule shells out to `git submodule update --init --recursive`, so making
  it a dependency of `fetch` would let any `//:gates` run rewrite the
  operator's working copy as a side effect of running a test suite, and on a
  linked worktree that side effect reaches a second checkout.
- The wasm reproducibility gate needs `x86_64-unknown-linux-gnu`; this host is
  `aarch64-apple-darwin`, confirmed against `canonicalHost` in
  `crates/flows-jj/build-wasm.mjs`. The script refuses a foreign host by
  design rather than report a byte diff, because cargo builds every build
  script for the host and rustc folds the host triple into each `-C metadata`
  hash. So `//crates/flows-jj:wasmReproducibility` cannot pass here even once
  the submodule lands; it needs the container command the script prints, or
  CI.
- `test/ServiceSupervisor.test.ts` "SIGINT teardown" fails on this machine
  under load (load average 76 while the port ran) and fails identically on
  the unmodified base commit. It is a load-sensitive 10-second timeout, not a
  regression from this branch.
- The examples suite passes 58 of 59; the live smoke needs an OpenAI seat
  with credit.
- `//packages/build-cli:lint` reports seven errors on this host that a
  case-sensitive filesystem cannot produce. Three read `Casing of
  @smthrs/targets/Package does not match the underlying filesystem`, and the
  other four are the `import/namespace` errors that follow from that failed
  resolution (`'metadata' not found in imported namespace 'PackageValue'` and
  the same for `isPackage` and `targetKeyPattern`).

  An earlier revision of this file said they reproduce on the unmodified base
  commit. That was wrong, and the correction matters more than the errors do.
  The base check was run under `git stash`, which reverts tracked
  modifications and leaves committed files alone, so the new `PACKAGE.ts`
  files were still on disk and the tree under test was never the base tree.
  `git cat-file -e 84ac43ad1e:packages/targets/PACKAGE.ts` fails: that file
  does not exist at the base, and this branch introduced it.

  The mechanism is the convention meeting a case-insensitive filesystem.
  `packages/targets/src/Package.ts` is an ordinary source module, and the
  package's export map sends `@smthrs/targets/Package` to it. Adding
  `packages/targets/PACKAGE.ts` at the package root gives the resolver a
  second file whose name differs only in case, and eslint's resolver reaches
  the declaration file instead of the module. Probing with
  `eslint --stdin --stdin-filename src/PackageIndex.ts` over an import of
  `@smthrs/targets/Package` shows only `Package` resolving, never `metadata`,
  `isPackage`, or `targetKeyPattern`, which is what the source module exports.

  So this is a hazard of the PACKAGE.ts convention itself, not of this
  repository: any package that ships a `Package.ts` module gains a
  case-colliding sibling the moment it declares a `PACKAGE.ts`. Linux CI does
  not see it, because there the two names are distinct files. `tsc` does not
  see it either; `//packages/targets:check` is green. Only eslint's resolver
  is affected. The lint is not weakened to hide it, and the fix belongs
  upstream in either the convention or the resolver configuration rather than
  in a suppression here.

## Open questions

1. Does the BUILD.ts graph get deleted at the flip, or do both conventions
   ship for a release? The generated `ci.yml` still belongs to BUILD mode and
   is listed in the `preserve` set, so nothing is lost yet either way.
2. Should `PackageDefaults` gain a package-mode equivalent, or is one
   explicit file per package the convention the factory wants?
3. The four lanes are declared but unrun. Running `waveReconciliation`
   against a real wave is the next proof.
