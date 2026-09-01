# Smithers on the Smithers factory

Date: 2026-08-31. Repo: smithersai/smithers, `v1/rc0-migration` at 84ac43ad1e.
Branch: `smthrs-dogfood`. Detail: `SMITHERS-NOTES.md`,
`WORKFLOW-CANDIDATES.md`, `research/*.md`, `docs/migration/package-mode-port.md`.

## The one sentence

Smithers shipped a factory that turns a partner repository into a typed target
graph with agent lanes, but it never ran that factory on itself, so its own
274-commit-in-three-days lane output was still reconciled by hand; pointing the
graph at this repository produced 600 labels, four evidenced agent lanes, two
gates for invariants that had no enforcer, and four engine defects that only a
repository of this shape could surface.

## Why this repo

- 7,280 commits, 52 published packages, seven apps, four eval suites, one Rust
  crate, a vendored `jj` submodule. Nothing in the partner set has this shape,
  which is exactly why it found what it found.
- The rc.0 regime is 384 commits, and 274 of them are authored by
  `lane <lane@local>` over three days. The lanes already write the code. A
  human still merges the branches, regenerates `known-files.d.ts`, regenerates
  the llms bundles, refreshes both lockfiles, and re-greens main afterward:
  65 merge and migrate commits in those same three days, four of them the
  literal message `merge(pack): build against the current cli-ops tip`.
- Issue #1443 is the case in the maintainer's own words: ten hours of red main
  across ten runs, four distinct classes of drift, "each fixed by hand
  afterwards", because the gate ran on a worktree while the pushed tree was
  incomplete.
- Two invariants were written down and unenforced. `AGENTS.md` says a manifest
  change refreshes both lockfiles in the same commit; 117 commits touched only
  `pnpm-lock.yaml` and 91 touched only `bun.lock`. `tsconfig.json` is generated
  and committed, and no CI job checked it for drift.

## What runs today (macOS 25.2.0, arm64, node v24.18.0, pnpm 11.21.0)

| Run | Result |
| --- | --- |
| `query '//...'` | 600 labels, no refusal |
| `graph '//...'` | builds, `warnings: []` |
| `target '//workflows/wave-reconciliation:waveReconciliation' --plan` | plans, `mode: execute` |
| `target '//:ci' --plan` | plans |
| `target '//:preCommit' --plan` | plans |
| `target '//:agentLints' --plan` | plans, four diff-scoped lints |
| `target '//packages/canonical:lint'` | green, `ran 7.2s`, second run `hit 3ms` |
| `target '//packages/canonical:fmt'` | green, `ran 428ms`, second run `hit 7ms` |
| `target '//packages/canonical:check'` | green, `ran 2.2s` |
| `target '//:knownFiles'` | green, `ran 10.8s`, second run `hit 3.2ms` |

## What the graph holds

- **The named queue**, `//workflows/wave-reconciliation:waveReconciliation`:
  the post-wave reconciliation, with the regenerations and the committed-tree
  root check from #1443 written into its `SKILL.md` as steps rather than as
  folklore.
- **Three more lanes** from the same mining pass: `effect-bump` (the pinned
  Effect version is a hand-edited constant that touches every manifest, both
  lockfiles, and the release contract), `new-agent-adapter` (about one adapter
  a month, each reopening the same four-item gap set), and `ci-red-triage`
  (115 of 1,000 issues are CI-themed).
- **Four judgment lints**, three ported from `lint/BUILD.ts` and one new:
  `adapter-conformance`, from issues #1622 through #1626 closed by PR #1627.
- **Two new deterministic gates**: `//:tsconfig` drift, and
  `//scripts:lockfilePair`, which compares every workspace manifest against
  both lockfiles.

## What it found in the engine

Four defects, each of which refused a real target, each fixed with a
red-then-green test:

1. `PackageDiscovery` probed for `WORKSPACE.ts` with `lstat`, and macOS
   resolves that to a file committed as `Workspace.ts`. This repository ships
   `packages/build-cli/src/Workspace.ts`, so **the CLI refused its own graph**.
2. `git diff` reports a moved submodule pointer as a gitlink, which cannot be
   digested, so **every diff-scoped lint failed in any repository with a
   submodule**.
3. `S.NodeModule.Bin` is documented as package local but resolved only at the
   workspace root, so in a pnpm workspace **every per-package tool refused**.
4. Shell targets had no working directory, and eslint, dprint, and vitest all
   resolve their config against it, so **a package's own lint or format gate
   could not be expressed at all**.

Numbers one and three are invisible to a single-package repository on Linux.
Number four is invisible to any repository whose tools are configured at the
root. The factory found them by being pointed at the hardest repository
available, which is the argument for dogfooding stated as a result rather than
as a principle.

## The ask

Run `//workflows/wave-reconciliation:waveReconciliation` against the next real
lane wave and compare its output against what the wave cost by hand. That is
the only number this branch does not yet have.
