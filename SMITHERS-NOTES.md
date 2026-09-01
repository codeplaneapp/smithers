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

## Open questions

1. Does the BUILD.ts graph get deleted at the flip, or do both conventions
   ship for a release? The generated `ci.yml` still belongs to BUILD mode and
   is listed in the `preserve` set, so nothing is lost yet either way.
2. Should `PackageDefaults` gain a package-mode equivalent, or is one
   explicit file per package the convention the factory wants?
3. The four lanes are declared but unrun. Running `waveReconciliation`
   against a real wave is the next proof.
