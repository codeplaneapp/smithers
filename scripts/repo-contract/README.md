# Repo-contract gates

The claims this repository makes about itself, checked. Each file here is a
`node:test` suite that reads the real tree rather than a fixture, because the
defects they exist for are the ones a fixture cannot have: a package that is
installed and never tested, a barrel that typechecks and throws at load, a
fault case that has quietly not run since somebody focused a test in it.

Run them all:

```sh
node --test "scripts/repo-contract/*.test.mjs"
```

Or by label, which is what CI does:

```sh
pnpm exec smithers-build test '//scripts/repo-contract/...'
```

| Suite | What it guards |
| --- | --- |
| `package-contract.test.mjs` | One version across the release line, a declared publishable surface, the `rc` dist-tag, the scripts every gate invokes, and no published dependency on a private package. |
| `barrels.test.mjs` | `@smthrs/flows` re-exports exactly the namespaces it lists, declares every package it re-exports, and every published root export points at a file that exists. |
| `test-script-wiring.test.mjs` | Every workspace member with tests has a `test` script, and the pnpm workspace and the root manifest name the same members. |
| `fault-skips.test.mjs` | No focused or parked test in `e2e/`, and every conditional skip and inverted expectation is declared with its reason. |
| `machine-paths.test.mjs` | No tracked file under `e2e/`, `evals/` or `scripts/` names one machine's home directory. Recorded material — wave reports, archives, the authoring corpus — is exempt, because rewriting it would falsify a record. |

## Ported from Smithers 0.x

These replace `packages/smithers/tests/`, which is gone. Fifteen suites lived
there. Three of them — the bin-delegation trio — are the cli-ops lane's, per the
disposition ledger's `packages/smithers/src/bin` row: they pin the bin that row
ports, and they travel with it. Of the twelve this lane owns, four requirements
survived the migration. The rest are recorded below with why they did not, so
each deletion is a decision rather than an omission.

| 0.x suite | Disposition |
| --- | --- |
| `package-and-build-contract`, `package-and-build-process-contract` | Ported into `package-contract.test.mjs`. The half that asserted a `tsup` entry-point layout, a `dist/` shape, and a bin shim went with the build system; the manifest claims survived. |
| `barrels`, `umbrella-agent-exports` | Ported into `barrels.test.mjs`. The 0.x umbrella is now a migration notice that throws, so "re-exports the agent surface" became "refuses to run". |
| `test-script-wiring-gate` | Ported into `test-script-wiring.test.mjs`. The 0.x version drove `scripts/check-smithers-test-script.mjs` against synthetic workspaces; the script is gone, so the claim is checked against the real tree. |
| `fault-skip-audit-gate`, `fault-only-todo-audit` | Ported into `fault-skips.test.mjs`. The 0.x ratchet pinned a per-file skip *count*; this one requires a declared reason instead, which is the thing a reviewer can act on. |
| `effect-version-gate` | Dropped. It unit-tested `scripts/check-single-effect-version.mjs` against synthetic lockfiles. That script survived the migration and is executed against the real tree as `//scripts:effectVersion`, which is a stronger check than a fixture. |
| `version-bump-propagation` | Dropped. It tested `scripts/bump.mjs`, which is gone; version propagation is now `scripts/set-release-version.mjs` and has its own suite at `//scripts:releaseVersion`. |
| `release-tag-guard` | Dropped. `scripts/release-tag-guard.mjs` has no successor: the RC release flow is `release.yml`, whose dry-run and tag-push paths are covered by `//scripts:releaseRehearsal`. |
| `coverage-script-gate` | Dropped. It tested `scripts/coverage.mjs` and the Bun LCOV merge, neither of which exists. Coverage is vitest's, and the gate that keeps its denominator honest is `packages/flows/test/vitestCoverageIsolation.test.ts`. |
| `workspace-test-sharding` | Dropped. `scripts/run-workspace-tests.mjs` and the Windows shard runner are gone; the Windows lane runs `//packages/...` directly. |
| `bin-smithers-delegation`, `bin-dangling-workspace-link-hint`, `dangling-many-links` | Not this lane's. The disposition ledger assigns all three to the `packages/smithers/src/bin` row, which the cli-ops lane executes. That lane ported them: the dangling-workspace-link diagnosis is `packages/cli/bin/dangling-workspace-links.mjs`, driven by `packages/cli/test/DanglingWorkspaceLinks.test.ts`, and the shim's resolution order is `packages/cli/test/Bin.test.ts`. The 0.x delegation to a locally installed CLI has no successor, because `@smthrs/cli`'s bin runs `dist/esm/bin.js` or `src/bin.ts` in its own package and delegates to nothing. |
