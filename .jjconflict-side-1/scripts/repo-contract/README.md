# Repo-contract gates

The claims this repository makes about itself, checked. Each file here is a
`node:test` suite that reads the real tree rather than a fixture, because the
defects they exist for are the ones a fixture cannot have: a package that is
installed and never tested, a barrel that typechecks and throws at load, a
fault case that has quietly not run since somebody focused a test in it.

Two records sit beside the suites rather than inside them.
[`fault-gaps.md`](./fault-gaps.md) is what the fault matrix does not cover and
what closing each entry would cost; [`fault-flake-log.md`](./fault-flake-log.md)
is the hand-kept flake history. Both used to live in the standalone `e2e/`
workspace member. The cases moved into the packages they test, and these two are
the part of that directory that belongs to no single package: they are read
across all of them.

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
| `package-contract.test.mjs` | One version across the release line, a declared publishable surface, the `next` dist-tag, the scripts every gate invokes, and no published dependency on a private package. |
| `barrels.test.mjs` | `@smthrs/flows` re-exports exactly the namespaces it lists, declares every package it re-exports, and every published root export points at a file that exists. |
| `test-script-wiring.test.mjs` | Every workspace member with tests has a `test` script, and the pnpm workspace and the root manifest name the same members. |
| `fault-skips.test.mjs` | No focused, parked, or inverted test in any package's `test/faults` tree, every conditional skip declared with its reason, every required gate still in the matrix — including the ones that are red — and every package carrying fault cases wired to a `faults` target, a serial fault config, and the CI step that runs them. |
| `machine-paths.test.mjs` | No tracked file under `evals/`, `scripts/`, or a package's `test/faults` tree names one machine's home directory. Recorded material — wave reports, archives, the authoring corpus — is exempt, because rewriting it would falsify a record. |

## Retired-suite coverage

These gates preserve the requirements that remain relevant from the retired
test suite. The table records where each surviving behavior is checked and why
obsolete checks were removed.

| Retired suite | Outcome |
| --- | --- |
| `package-and-build-contract`, `package-and-build-process-contract` | Ported into `package-contract.test.mjs`. The half that asserted a `tsup` entry-point layout, a `dist/` shape, and a bin shim went with the build system; the manifest claims survived. |
| `barrels`, `umbrella-agent-exports` | Ported into `barrels.test.mjs`. The 0.x umbrella is now a migration notice that throws, so "re-exports the agent surface" became "refuses to run". |
| `test-script-wiring-gate` | Ported into `test-script-wiring.test.mjs`. The 0.x version drove `scripts/check-smithers-test-script.mjs` against synthetic workspaces; the script is gone, so the claim is checked against the real tree. |
| `fault-skip-audit-gate`, `fault-only-todo-audit` | Ported into `fault-skips.test.mjs`. The 0.x ratchet pinned a per-file skip *count*; this one requires a declared reason instead, which is the thing a reviewer can act on. It also refuses `.fails`, which the 0.x gate had no rule about, and it pins the required gates by title. The two rules are one rule: when the product does not meet a requirement the matrix covers, the sanctioned form is a plain test that fails, kept in the matrix with its owner cited and reported as a failure in the gate line. `.fails` turns that test into a pass and deletion turns it into prose; `requiredRedGates` refuses the deletion and the `.fails` rule refuses the marking. `fault-gaps.md` beside it records the shipped limitation next to the red gate, not instead of it. |
| `effect-version-gate` | Dropped. It unit-tested `scripts/check-single-effect-version.mjs` against synthetic lockfiles. That script survived the migration and is executed against the real tree as `//scripts:effectVersion`, which is a stronger check than a fixture. |
| `version-bump-propagation` | Dropped. It tested `scripts/bump.mjs`, which is gone; version propagation is now `scripts/set-release-version.mjs` and has its own suite at `//scripts:releaseVersion`. |
| `release-tag-guard` | Dropped. `scripts/release-tag-guard.mjs` has no successor: the RC release flow is `release.yml`, whose dry-run and tag-push paths are covered by `//scripts:releaseRehearsal`. |
| `coverage-script-gate` | Dropped. It tested `scripts/coverage.mjs` and the Bun LCOV merge, neither of which exists. Coverage is vitest's, and the gate that keeps its denominator honest is `packages/smithers/flows/test/vitestCoverageIsolation.test.ts`. |
| `workspace-test-sharding` | Dropped. `scripts/run-workspace-tests.mjs` and the Windows shard runner are gone; the Windows lane runs `//packages/...` directly. |
| `bin-smithers-delegation`, `bin-dangling-workspace-link-hint`, `dangling-many-links` | The dangling-workspace-link diagnosis is `packages/smithers/bin/dangling-workspace-links.mjs`, driven by `packages/smithers/test/DanglingWorkspaceLinks.test.ts`, and the executable resolution order is pinned by `packages/smithers/test/Bin.test.ts`. Delegation to a locally installed CLI has no successor because `@smthrs/cli` runs `dist/esm/bin.js` or `src/bin.ts` in its own package and delegates to nothing. |
