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
| `query '//...'` | 600 labels, no refusal |
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
| `target '//:preCommit'` | 339 targets, 335 ran, 2 hit, 1 member failed, 178.2s |

`//:preCommit` is the whole repository's static gate surface: every package's
typecheck, lint, and format, plus the five root gates, plus the apps, evals,
and examples typechecks. It runs in three minutes from cold. The single failing
member is `//packages/build-cli:lint`, which fails identically on the
unmodified base commit for a reason this host causes; see "Failure modes and
host drift".

The cache hits are the point. `//packages/canonical:lint` costs 7.2 seconds
cold and 3 milliseconds when nothing it reads has changed.

## Label inventory

`query '//...'`, counted by rule:

| Rule | Labels |
| --- | --- |
| Shell.Test | 318 |
| Filegroup | 123 |
| Suite | 76 |
| Shell.Build | 50 |
| Github.Workflow | 9 |
| Shell.Run | 5 |
| Agent.Lint | 4 |
| Agent.Diff | 4 |
| Alias | 2 |
| Cargo.Fetch, Cargo.Fmt, Cargo.Clippy, Cargo.Test | 1 each |
| Github.Setup, Github.CiGen, Git.Commit, Git.Pr, Generate | 1 each |

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

- The `vendor/jj` submodule is not initialized in this worktree, so the
  native Cargo targets refuse until `git submodule update --init`.
- The wasm reproducibility gate needs `x86_64-unknown-linux-gnu`; this host
  is `aarch64-apple-darwin`.
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
  the same for `isPackage` and `targetKeyPattern`). They reproduce identically
  on the unmodified base commit, and the rule that emits them tests the
  filesystem's own casing behavior, so Linux CI does not see them. The lint is
  not weakened to hide them.

## Open questions

1. Does the BUILD.ts graph get deleted at the flip, or do both conventions
   ship for a release? The generated `ci.yml` still belongs to BUILD mode and
   is listed in the `preserve` set, so nothing is lost yet either way.
2. Should `PackageDefaults` gain a package-mode equivalent, or is one
   explicit file per package the convention the factory wants?
3. The four lanes are declared but unrun. Running `waveReconciliation`
   against a real wave is the next proof.
