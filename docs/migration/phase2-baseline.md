# Phase 2 baseline

PLAN.md Phase 2 step 4: run the imported repository's gates in this tree before
any feature port begins, so later phases measure against a recorded starting
point rather than a memory.

Tree: `v1/rc0-migration` at `b8af974334` (the Flows catch-up through
`smithersai/flows@4464c7e`) plus the root reconciliation this document records.
Reference baseline: the flows import reference `393253c2b`, summarized under
"Pre-existing red at the reference" in the migration notes and reproduced in the
classification tables below. Host: macOS arm64, Node 24.18.0, Bun
1.4.0-canary.1, pnpm 11.21.0.

## 1. Commands and results

| Command                                                   | Exit | Final line                                                                     |
| --------------------------------------------------------- | ---- | ------------------------------------------------------------------------------ |
| `corepack pnpm install --frozen-lockfile --offline`       | 0    | `Already up to date` (58 workspace projects)                                   |
| `bun install --frozen-lockfile --offline --lockfile-only` | 0    | `Saved bun.lock (2174 packages)`; byte-identical across three consecutive runs |
| `corepack pnpm -r --no-bail --if-present run check`       | 0    | 53 packages, `packages/build-cli check: Done`                                  |
| `corepack pnpm -r --no-bail --if-present run test`        | 1    | `Summary: 2 fails, 55 passes`                                                  |
| `corepack pnpm -r --no-bail --if-present run lint`        | 0    | every package `Done`                                                           |
| `corepack pnpm -r --no-bail --if-present run build`       | 0    | every package `Done`                                                           |
| `corepack pnpm run test:jsdoc`                            | 0    | `pass 5 / fail 0`                                                              |
| `corepack pnpm run browser`                               | 0    | `browser contract holds: 28 browser entry points, 7 Node-only`                 |
| `node scripts/check-single-effect-version.mjs`            | 0    | `effect@4.0.0-rc.108 everywhere (58 sources)`                                  |
| `node scripts/check-dependency-boundaries.mjs`            | 0    | `Dependency boundary check passed for 58 package(s).`                          |
| `node scripts/check-local-smithers.mjs`                   | 0    | `internal scripts run the Smithers working tree`                               |
| `node scripts/check-npm-dedupe.mjs`                       | 1    | `effect resolves to 24 copie(s) at 4.0.0-rc.108, 4.0.0-rc.112`                 |
| `node scripts/check-legacy-absent.mjs`                    | 1    | 947 files remain under `legacy/` (expected until Phase 4 ends)                 |
| `pnpm exec smthrs lint '//:ci'`                           | 0    | generated workflow matches the checked-in file                                 |
| `pnpm exec smthrs lint '//:tsconfig'`                     | 0    | generated tsconfig matches the checked-in file                                 |
| `pnpm exec smthrs build '//packages/...'`                 | 0    | 99 targets, 0 failed                                                           |
| `pnpm exec smthrs ci '//packages/...' --jobs 4`           | 1    | 334 targets, 1 failed (`//packages/build-cli:test`, Docker)                    |
| `pnpm exec smthrs test '//scripts/...'`                   | 1    | 12 targets, 2 failed                                                           |

Every number in this table is a Phase 2 snapshot at `b8af974334`, not a current
reading. Two things have moved since: Phase 3 renamed the build CLI's bin from
`smthrs` to `smithers-build`, so the last five rows re-run under the new name,
and the manifest changes in Phase 3 shifted the package counts. Current readings
live in `phase3-validation.md`.

The `lint` result is better than the reference, which was red on five
`engine-store` dprint files, one `flow` eslint-disable warning, and 26
`core`/`patterns` files using a `@slop` JSDoc tag. The catch-up commit resolved
all three upstream. `check` is likewise green where the reference had 37 errors
across `examples`, `packages/build/infra`, `engine`, `jj`, `testing`, and
`time-travel`.

## 2. Failing set and classification

### 2.1 `pnpm -r run test` (2 packages)

| Package              | Failing tests                                                                              | Classification                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `examples`           | 1 of 14: `12-agent-live-smoke > runs the assembled agent stack against a real OpenAI seat` | **Environmental.** The seat returns `You have no credits remaining`. Named in the reference baseline. `11-agent-step` now passes, so the reference's two-test entry has shrunk to one. |
| `packages/build-cli` | 3 of 813, all in `test/ChainExecution.test.ts` `Docker package execution`                  | **Environmental.** `docker info` exits 1 on this host; the CLI is installed but no daemon runs. Named in the reference baseline.                                                       |

Nothing else fails. `packages/sync`'s `ServerSoak`, listed as nondeterministic in
the reference, passed on every run here.

### 2.2 `smthrs test '//scripts/...'` (2 targets)

| Target                      | Failure                                                                                                                                               | Classification                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `//scripts:releaseVersion`  | `apps/ui: dependencies.@smthrs/ui is 0.33.0, expected 0.1.0`                                                                                          | **Pre-existing, deferred with evidence.** See section 5.                                                                                                                                                                                                                                                             |
| `//scripts:testPinRegister` | `packages/create-app/template/aomi/test/tevm.test.ts:215` `describe.skip("layerTevm against a mainnet fork")` is not in the "Surviving pins" register | **Imported content.** The file arrived with the catch-up commit and is unmodified here. rc-contract section 9 states one documented pin; the catch-up added a second. Fix: a row in `docs/alpha-notes.md` "Surviving pins" plus its rationale paragraph, owned by ledger row DOC-5 (`docs/alpha-notes.md`, phase 3). |

`//scripts:releasePack` and `//scripts:releaseSmoke` also fail until the
packages are built: `releasePack` declares `deps: []` while `pack-release.mjs`
asserts `dist/cjs` exists. They pass after `pnpm -r run build` and both are
green in the table above. The gap is upstream, not a reconciliation one, and CI
does not close it. The `lib` target is a `TsBuild` that emits `dist/esm` only;
`dist/cjs` comes from each package's own `scripts/build.mjs` esbuild step, which
no target declares. Verified by deleting `packages/canonical/dist/cjs` and
running `smthrs ci '//packages/canonical/...'`: it exits 0 and does not
recreate the directory. The `test` job runs `smthrs ci '//packages/...'` and
then `smthrs test '//scripts/...'` with no `pnpm -r run build` between them, so
`//scripts:releasePack` is red in CI as shipped. Fix: declare the edge, or add
the missing esbuild step to the `lib` target.

### 2.3 Reconciliation-caused failures, fixed here

Three suites went red because the reconciliation changed what the imported
tooling walks. All three are fixed in this change and pass.

| Suite                                                 | Cause                                                                                                                                                   | Fix                                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `packages/targets` `GeneratedRootFiles`               | Root `PACKAGE.ts` gained `legacy/**` in `exclude`; the drift check restates the declaration as a literal.                                               | The literal now carries `legacy/**` with the reason.                                                                              |
| `packages/flows` `vitestCoverageIsolation` (10 tests) | The universe is every `packages/*` directory with a `package.json`. The two retained 0.x UI kits carry 0.x tooling and satisfy none of the flows shape. | A named `zeroXUiKits` carve-out, deleted by the Phase 4 UI port.                                                                  |
| `packages/observability` `NoConsole`                  | The guard walks every `packages/*/src` and found `packages/ui/src/sandbox/WebPreview.tsx`.                                                              | The same two names, skipped, with the reason: the guard's subject is engine source that must log through `@smthrs/observability`. |

## 3. Retained 0.x packages under `packages/`

Phase 1 kept `@smthrs/ui` and `@smthrs/ui-styleguide` unchanged because the
imported product UI imports them (ledger rows `packages/ui` and
`packages/ui-styleguide`, disposition `keep`). Phase 2 then imported a build
system that inventories `packages/*` automatically. The two kits collide with
that inventory in four places. Two are the conformance carve-outs in section
2.3; the other two, and one manifest change that is not a collision, follow.

- Root `packageDefaults` synthesized a `StandardPackage` (tsc library build,
  vitest at 100% coverage, eslint, dprint) for each. `ui-styleguide` has no
  `tsconfig.json` and `ui` types against an uninstalled `bun-types`, so
  `smthrs build '//packages/...'` failed on both. Each now ships a `PACKAGE.ts`
  declaring the one target it can honor, its existing `bun test tests` suite.
  A directory holding a `PACKAGE.ts` opts out of the synthesis, which is the
  sanctioned mechanism. Both suites pass: 904 tests in `ui`, 53 in
  `ui-styleguide`.
- `packages/ui` declared `build` (tsup) and `typecheck` (`bun-types`) scripts
  naming tools the 1.0 tree does not install, so `pnpm -r run build` failed.
  Both scripts and `tsup.config.ts` are removed. The package publishes nothing
  at rc.0 and is consumed as source through `exports` and `files: ["src/"]`, so
  the declarations it built were only for the 0.x npm tarball.
- Both manifests moved from `0.35.0` to `0.1.0`, the version every other
  workspace package carries, and gained `smthrs.group: "agent"`. Phase 3 sets
  `private: true` on both (rc-contract section 3.2) before `pack-release.mjs`
  widens to the `{engine, agent}` groups; until that flip lands, the widening
  would pack them.

## 4. `legacy/` containment

`legacy/` holds 947 tracked source files that later phases port from. It is
excluded from every walk the tooling performs:

| Walk                                                                   | Mechanism                                                                                                            |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| pnpm workspace                                                         | never a member of `pnpm-workspace.yaml`                                                                              |
| root TypeScript program                                                | `legacy/**` in root `PACKAGE.ts` `exclude`, rendered into `tsconfig.json`                                            |
| `@smthrs/targets` declared-input scan, eslint, vitest, dprint, ripgrep | `legacy/.gitignore` (`*` with `!.gitignore`); `known-files.d.ts` lists one path under `legacy/`, its own ignore file |
| `check-single-effect-version`                                          | `SKIPPED_DIRECTORIES`                                                                                                |
| `check-dependency-boundaries`                                          | `ignoredDirs`                                                                                                        |
| `check-local-smithers`                                                 | ignore list                                                                                                          |
| Docker build context                                                   | `.dockerignore`                                                                                                      |

`pnpm run check:legacy-absent` (`scripts/check-legacy-absent.mjs`) is the Phase 7
gate. It fails while any file other than `legacy/.gitignore` remains, which is
the intended state until the last Phase 4 port lands. It is a root script rather
than a `//scripts/...` target for exactly that reason: a target would make the
required CI job red for the length of the migration.

## 5. Deferred with a recorded reason

### `apps/ui` still depends on registry `@smthrs/ui@0.33.0`

**Resolved in Phase 3. The diagnosis below was wrong; the paragraph after it
records what the cause actually was.**

Ledger decision D14 assigns the swap to `workspace:*` to Phase 3. Applying it
here was tried and reverted: `apps/ui` typechecks against the workspace kit
(`tsc --noEmit` exits 0), but its unit suite went from 1084 passing to 90
failures and 23 errors, concentrated in status pills, drawer opening, and card
rendering. Phase 2 read that as the `0.33.0`-to-`0.35.0` behavioral delta in
`packages/ui/src`, deferred the swap to the Phase 4 UI port, and accepted
`//scripts:releaseVersion` staying red until then.

The failures were a duplicated React, not a behavior delta. `apps/ui` pins
`react` at exactly `19.2.7`; `packages/ui` declared `^19.2.7`, which resolved to
`19.2.8`. The registry tarball resolved React through its `peerDependencies` and
so shared the app's copy, but `workspace:*` links `packages/ui/src` directly,
and its own `node_modules/react` then won for every module under it. Two React
copies in one tree produce exactly the observed shape: `Invalid hook call` at
`packages/ui/src/styles.tsx` `useInjectUiCss`, and every component that injects
styles renders nothing. Pinning `packages/ui`'s `react` and `react-dom`
devDependencies to `19.2.7`, the version every consuming app already pins,
makes the swap green: `bun test src` in `apps/ui` runs 1084 tests, 0 fail, and
`//scripts:releaseVersion` passes. See `phase3-validation.md` section 2.

### `check-npm-dedupe` fails on Effect duplication

Every published manifest pins `effect` at exactly `4.0.0-rc.108`, and
`check-single-effect-version` confirms one version across every manifest, both
lockfiles, and the install. An npm consumer gets something else: upstream
`@effect/platform-node@4.0.0-rc.108` and `@effect/sql-sqlite-node@4.0.0-rc.108`
declare `effect: ^4.0.0-rc.108`, npm hoists the newest matching release
(`4.0.0-rc.112`), and each exact pin nests its own copy. The gate reports 24
copies. Two Effect instances do not share schema internals, so this is a
correctness defect in a published tarball, not a size problem. It is the exact
failure mode the gate was written for after Smithers 0.31.0 shipped roughly
660 MB of duplicated Effect. Phase 3 owns the fix, which is a decision about the
pin strategy rather than an edit: pin at the newest rc at release time, move to
a caret range, or publish a required `overrides` recipe. rc-contract section 9's
Effect row states the compatibility promise this has to satisfy.

### `scripts/check-llms.mjs` and its three companions stay in `legacy/`

Ledger rows put `scripts/{check-llms.mjs,llms-check-mode.mjs,llms-version-guard.ts,llms-version-guard.test.ts}`
at phase 3 and their generators, `scripts/{generate-llms.ts,optimize-llms-full.ts}`,
at phase 4. The gate checks that generated llms bundles are current; with no
ported generator and no bundles it can only fail. The four files therefore move
with the Phase 4 docs lane that rewrites the generators against the vocs
`docs/pages` tree, in the same change that widens the root-scripts pin in
`packages/flows/test/vitestCoverageIsolation.test.ts` (rc-contract section 9,
exception 2). No file was dropped.

### `codex-plugin` is not a workspace member

The old `pnpm-workspace.yaml` listed `packages/*`, `apps/*`, `e2e`, `.smithers`,
and `codex-plugin`. rc-contract section 9's Workspace row names the rc.0
membership: `packages/*`, `packages/build/infra`, `examples`, `apps/*`, plus
`e2e` when the rewritten suite lands. `.smithers` is deleted in Phase 1;
`codex-plugin` survives with a `keep` disposition but is not in the contract's
list, so its `bun test` suite does not run under the root fan-out today. Its
ledger row already carries a Phase 4 re-check.

### `//:knownFiles` lint

`smthrs lint '//:knownFiles'` exits 1 while `node scripts/generate-known-files.mjs`
produces no diff, so `known-files.d.ts` is current. No CI lane runs that target;
the required drift checks are `//:ci` and `//:tsconfig`, both green. Left as an
imported-target quirk for the build-system owner.

## 6. Regenerated and reconciled root files

`.github/workflows/ci.yml` was regenerated. The committed flows copy predated
`GithubCiGen`'s artifact-copy renderer, so `smthrs lint '//:ci'` was red at
`b8af974334`; the regenerated file passes. The visible change is that the two
`apps-e2e` collection lines lost their `2>/dev/null || true` suffix, which the
generator does not emit. The generator's own doc comment still calls collection
"best-effort", which it no longer is. That is an upstream defect worth a
report, not a hand edit to a generated file.

`LICENSE` is not reconciled. It keeps the imported line verbatim:
`Copyright (c) 2026 William Cory and the Smithers Flows contributors`, which the
owner confirmed as final on 2026-08-17 (flows `HUMAN-TASKS.md` H2 and
`docs/release-runbook.md`) and which `rc-contract.md` ruling R-26 freezes. An
earlier pass of this reconciliation rewrote the root file to
`Copyright (c) 2025-2026 William Cory and the Smithers contributors` and swept
the same rename through the 42 per-package copies, reasoning that 2025 covers
the retained 0.x sources and that the repository name no longer applies. The
reasoning is sound and the edit is still out of scope: R-26's rationale is that
changing an owner-confirmed legal string is not a default, and the file ships in
every published tarball. The rewrite is reverted.
The root file and 43 package copies now carry the R-26 line byte-identically,
the 43rd being the new `packages/smthrs-deprecation`, which arrived with a third
wording. `packages/canonical` and `packages/observability` came from the import
with `Copyright (c) Smithers` and are left exactly as imported. Whether to widen
the year to `2025-2026`, drop `Flows` from the string, and normalize those two
files is one maintainer question, recorded in `phase3-validation.md` section 12.

`SECURITY.md` and `vocs.config.ts` pointed at `github.com/smithersai/flows`, and
the docs site titled itself "Smithers Flows". Both now name
`github.com/smithersai/smithers` and "Smithers" (PLAN Phase 2 steps 1 and 2).
Internal identifiers keep the flows name because renaming them breaks real
things: the `crates/flows-jj` crate, the `packages/jj/wasm/flows_jj.wasm`
artifact and its reproducibility gate, the `flows-wasm` submodule branch, the
`flows-jsdoc` eslint plugin id, and the `@smthrs/flows` package.
