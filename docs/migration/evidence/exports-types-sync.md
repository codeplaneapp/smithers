# Phase 7 gate: exports-types-sync

Verdict: PASS

At `cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba` (`v1/rc0-migration`) in the clean checkout `migration/clean-checkout-4`, the package export/type synchronization contract holds for all 40 published packages: `known-files.d.ts` is current under the CI drift target, a read-only render, and the in-place generator; the generated root `tsconfig.json` is current; `exports` and `publishConfig.exports` agree with each other and with the files on disk; every public module has its `dist/esm/*.js`, `dist/esm/*.d.ts`, and `dist/cjs/*.js` after the release build recipe; all 581 public subpaths resolve and all 155 blocked subpaths refuse under Node require, Node import, and Bun; the repo-contract suite passes 12 of 12; and the tree is clean with no tracked `.d.ts` changed.

This file supersedes the 2026-08-31 07:27 to 07:33 UTC PASS taken at `163fdf4bf5` in `migration/clean-checkout-3` (its logs remain in `exports-types-sync/run3/`). Nineteen commits separate the two HEADs. The export surface moved by exactly one blocked module (`@smthrs/engine-store` `./internal/ExitEncoding`, added by `e44159b9ef`); no public subpath was added or removed. Logs for this run are in `exports-types-sync/run4/`.

## Gate definition

- PLAN.md Phase 7 requires "package export/type synchronization checks". Phase 3 states the claims the gate verifies: "exports resolve in Node, Bun, and supported browser builds" and "public types are generated and current". Browser resolution is the separate `browser-bundling` gate.
- `docs/migration/rc-contract.md` section 3.5: the wildcard surface is the contract; `./internal/*` and `./*/index` stay `null` in both `exports` and `publishConfig.exports`; "the Phase 7 export/type synchronization gate resolves every non-null subpath above under Node and Bun".
- rc-contract section 9 (CI lanes) and root `BUILD.ts` line 146 make `lint '//:knownFiles'` ("Known-file registry drift") a step of the required `test` job. `known-files.d.ts` is the only committed `.d.ts` a generator owns (`BUILD.ts` line 12, `Smithers.Generate` over `scripts/generate-known-files.mjs`, `changes: ["known-files.d.ts"]`). The other nine tracked declaration files are hand-written ambient declarations, template files, or test fixtures (step 17).
- rc-contract section 9 (Build system): per-package `scripts/build.mjs` emits tsc declarations to `dist/esm` and esbuild CJS to `dist/cjs`; `.github/workflows/release.yml` builds with `pnpm --recursive --if-present run build` after deleting every `packages/**/dist`. The publish artifacts this gate asserts on are the ones that recipe produces.

## Environment

| Item | Value |
| --- | --- |
| Host | macOS 26.2 (build 25C56), Darwin 25.2.0, arm64 |
| Node | v24.18.0 (`/Users/williamcory/.nvm/versions/node/v24.18.0/bin/node`) |
| Bun | 1.4.0-canary.1+6618e7f7e (`bun --version` prints `1.4.0`) |
| pnpm | 11.21.0 via corepack 0.35.0 (`packageManager: pnpm@11.21.0`) |
| TypeScript / esbuild | 6.0.3 / 0.28.1 |
| git | 2.50.1 (Apple Git-155) |
| Checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4` |
| HEAD | `cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba`; `git status --porcelain` empty before and after the gate; `git ls-files --others --exclude-standard` empty |
| Submodule | `vendor/jj` at `47589ada70c12b3e829b5c98ab32503abad49eac` (`v0.25.0-3759-g47589ada7`) |
| Install | frozen pnpm and Bun installs from `00-clean-install.md` at this HEAD; zero `packages/*/dist` directories existed at gate start (11:59:49 UTC) |
| Date | 2026-08-31 11:59:49 to 12:10:39 UTC (04:59 to 05:10 PT) |
| Host load | 28.32 at gate start, 60.85 after step 4, 62.63 at the release build start, 40.94 at its end, 87.33 after the first closing lint, 72.90 at the final step. Other Phase 7 lanes were running in the same checkout throughout; see "Concurrency in the shared checkout" |
| Free disk | 11 GiB |

`SMITHERS_HOME` was unset (`env -u SMITHERS_HOME`) for every command. Every command ran from the checkout root. Harness sources are unchanged from run3 and live beside this file in `exports-types-sync/` (`exports-sync-check.mjs`, `exports-import-resolve.mjs`, `exports-bun-resolve.ts`); `run4/render-known-files.mjs` is the run3 render script with the checkout path substituted.

## Commands and results

| # | Command | Exit | Final output |
| --- | --- | --- | --- |
| 1 | `pnpm exec smithers-build lint '//:knownFiles'` (11:59:49Z) | 0 | `//:knownFiles Generate ran 4802ms`, `1 targets: 0 hit, 1 ran, 0 failed, 0 skipped`, `ok: true` (`run4/lint-knownfiles.out`) |
| 2 | read-only render: `node run4/render-known-files.mjs > run4/known-files.regenerated.d.ts`, then `diff known-files.d.ts run4/known-files.regenerated.d.ts` | render 0, diff 0 | 11428 lines tracked, 11428 rendered, `run4/known-files.diff` 0 bytes, `run4/known-files.render.err` 0 bytes, zero `vendor/jj` entries with the submodule initialized |
| 3 | `pnpm exec smithers-build lint '//:tsconfig'` | 0 | `//:tsconfig Tsconfig ran 212ms`, `ok: true` (`run4/lint-tsconfig.out`) |
| 4 | `node scripts/pack-release.mjs --list` | 0 | 40 directories in publication order, `canonical` first, `cli` last (`run4/pack-release-list.out`) |
| 5 | `node scripts/generate-known-files.mjs` (in place, 12:01:12Z) | 0 | sha256 of `known-files.d.ts` unchanged: `01708e32bac13e041ef610c09db9dccb969860243535f4f137118652e75ec2be` before and after; `git diff --quiet -- known-files.d.ts` exit 0; `git status --porcelain` empty (`run4/generate-known-files.out`, `run4/known-files.sha256.{before,after}`) |
| 6 | `node --test scripts/repo-contract/package-contract.test.mjs scripts/repo-contract/barrels.test.mjs` (12:01:13Z) | 0 | `tests 12`, `suites 4`, `pass 12`, `fail 0` (`run4/repo-contract.out`) |
| 7 | release build recipe, serial in publication order: `for d in $(node scripts/pack-release.mjs --list); do env -u SMITHERS_HOME corepack pnpm --dir packages/$d run build; done` (12:01:15Z to 12:05:21Z) | 39 of 40 exit 0; `patterns` exit 1 | `run4/release-build.log`, per-package stdout in `run4/build-<dir>.out`. `patterns` failed in 1 s with `ENOTEMPTY, Directory not empty: .../packages/patterns/dist` at `scripts/build.mjs:16` (`rmSync(dist)`), a collision with the consumer-fixtures lane building the same package at that moment (see "Concurrency"). `dist` directories: 28 at build start (0 at gate start), 47 after (47 `esm`, 40 `cjs`) |
| 8 | `corepack pnpm --dir packages/patterns run build` alone (12:06:39Z) | 0 | `run4/build-patterns-rerun.out`; `dist/cjs` 60 entries, `dist/esm` 117 entries, `dist/cjs/package.json` is `{"type": "commonjs"}`. The recipe succeeds for `patterns` at this HEAD; step 7's failure was the two-builder race, not a package defect |
| 9 | `node exports-sync-check.mjs <root> run4/exports-expectations.json` (12:06:51Z) | 0 | `packages checked: 40` ... `exports-sync-check: OK` (`run4/sync-check.out`, line 43) |
| 10 | `node --experimental-import-meta-resolve exports-import-resolve.mjs run4/exports-expectations.json` | 0 | `node import-condition: 581 subpaths resolved, 155 blocked subpaths refused` / `exports-import-resolve: OK` (`run4/import-resolve.out`) |
| 11 | `bun exports-bun-resolve.ts run4/exports-expectations.json` | 0 | `bun: 581 subpaths resolved, 155 blocked subpaths refused` / `exports-bun-resolve: OK` (`run4/bun-resolve.out`) |
| 12 | `dist` mtime snapshot before step 9 and after step 11 | diff 0 | `run4/dist-mtimes.diff` 0 bytes: no `packages/*/dist` changed while steps 9 to 11 ran |
| 13 | `pnpm exec smithers-build lint '//:knownFiles'` (closing, 12:06:53Z) | 0 | `//:knownFiles ran 5.4s`, `1 targets: 0 hit, 1 ran, 0 failed, 0 skipped`, `ok: true` (`run4/lint-knownfiles-end.out`); `git status --porcelain` empty; untracked 0; `git diff --quiet -- '*.d.ts' '*.d.mts'` exit 0; HEAD unchanged |
| 14 | `corepack pnpm --dir packages/registry run build` alone (12:09:03Z) | 0 | `run4/build-registry-rerun.out`. Rebuilt because `registry`'s `dist/cjs/package.json` carried a 12:06:19Z mtime, after this gate's serial build ended, so a different lane had rewritten it |
| 15 | steps 9, 10, 11 repeated as `run4/sync-check-2.out`, `run4/import-resolve-2.out`, `run4/bun-resolve-2.out` (12:09:11Z) | 0, 0, 0 | `exports-sync-check: OK`; `581 subpaths resolved, 155 blocked subpaths refused` under Node import and under Bun. `run4/exports-expectations-2.json` is byte-identical to `run4/exports-expectations.json`. All 40 `dist/cjs/package.json` mtimes and all `dist` mtimes are identical before and after the three checks (`run4/cjs-markers-{before,after}-checks-2.txt`, `run4/dist-mtimes-{before,after}-checks-2.txt`) |
| 16 | reproducibility spot-check (12:10:16Z): sha256 every file under `packages/{canonical,migrate}/dist`, rebuild each with the recipe, hash again | both rebuilds 0 | `canonical`: 19 files before, 18 after; `migrate`: 187 before, 186 after. Every emitted `.js`, `.d.ts`, `.js.map`, `.d.ts.map`, and `dist/cjs/package.json` is byte-identical. The one delta in each is the removal of `dist/tsconfig.tsbuildinfo`, which `scripts/build.mjs` never writes (another lane's `tsc -b` left it) and which `scripts/pack-release.mjs:256` excludes from every tarball (`run4/repro-*.sha256`, `run4/repro-*.diff`) |
| 17 | tracked `.d.ts` inventory (`git ls-files`) | n/a | `apps/ui/src/mainview/vite-env.d.ts`, `known-files.d.ts`, `packages/build-cli/src/effect-resolution.d.ts`, `packages/build-cli/test/fixtures/{force-spec,viem-node-spec}/smithers.d.ts`, `packages/create-app/template/{aomi/src/shell,default/src}/virtual.d.ts`, `packages/harness/test/workerd/wasm.d.ts`, `packages/migrate/test/fixtures/jsx-single/mdx-assets.d.ts`, `scripts/package-api-sweep.d.mts`; none changed during the gate |

Timestamps and load readings for every step are in `run4/timeline.txt`.

## What the harness proves

`exports-sync-check.mjs` scans every non-private `packages/*` manifest whose `smthrs.group` is `engine` or `agent` (40 packages, the rc-contract section 3.1 roster, all at `1.0.0-rc.0`) and asserts, per package:

1. `exports` and `publishConfig.exports` carry identical key sets, and a key is `null` in one map exactly when it is `null` in the other (`./internal/*` and `./*/index` stay blocked in both).
2. Every concrete non-null `exports` target exists on disk, and none points into `src/internal/`.
3. Every concrete non-null `publishConfig.exports` entry declares `types`, `import`, and `require`, and all three files exist under `dist/`.
4. Every module under `src/**/*.ts`, pushed through the Node exports-pattern precedence (exact key, then longest wildcard prefix, then longest suffix), lands on a real target or on a deliberate `null`. For every resolvable module the built trio exists: `dist/esm/<m>.js`, `dist/esm/<m>.d.ts`, `dist/cjs/<m>.js`. The fresh release build at HEAD (steps 7, 8, 14) is what makes "public types generated and current" a measured fact rather than a committed artifact.
5. Wherever a `require` target lives under `dist/cjs/`, `dist/cjs/package.json` exists and declares `"type": "commonjs"`.
6. Every declared `bin` file exists (including `@smthrs/migrate`'s `dist/esm/flow/bin.js`).
7. Require-condition resolution: every public subpath resolves via Node self-reference to exactly the file the exports map names (realpath equality), and every `null` subpath throws `ERR_PACKAGE_PATH_NOT_EXPORTED`.

Steps 10, 11, and 15 rerun the same 581 public and 155 blocked subpaths under the Node import condition (`import.meta.resolve` with a parent URL inside each package) and under Bun (`Bun.resolveSync`) with identical results. The repo-contract suite (step 6) adds the manifest contract (one release version, publishable surface for every published package, `rc` dist-tag, exact sibling pins, no published-to-private edges) and the `@smthrs/flows` barrel runtime check.

`known-files.d.ts` is proven current three ways at this HEAD: the CI drift target (steps 1 and 13), a read-only render through `discoverKnownFiles` and `renderKnownFileDeclaration` from `packages/targets/src/KnownFile.ts` (step 2), and the real generator writing in place with no resulting diff (step 5). All three ran with `vendor/jj` initialized and produced zero `vendor/jj` entries.

## Delta from the superseded run

`run4/expectations-delta-vs-run3.txt` compares `run3/exports-expectations-3.json` (path-rebased to this checkout) with `run4/exports-expectations.json`:

- Public subpaths: 581 in both runs. No package added or removed a public subpath.
- Blocked subpaths: 154 in run3, 155 here. The addition is `@smthrs/engine-store` `./internal/ExitEncoding`, from `packages/engine-store/src/internal/ExitEncoding.ts` introduced by `e44159b9ef` ("fix(engine-store): persist a failed run whose exit cause the flow codec rejects"). It is under `internal/`, so it is `null` in both maps and refuses under Node require, Node import, and Bun, exactly as rc-contract section 3.5 requires. The per-package summary line moved from `28 public subpaths, 14 blocked, 40 src modules, 14 shipped-but-unexported` to `28 public subpaths, 15 blocked, 41 src modules, 15 shipped-but-unexported`; the other 39 summary lines are identical (`run4/run3-summary.txt` versus `run4/run4-summary.txt`).
- Manifest changes between the HEADs that touch this gate's inputs: `packages/testing/package.json` moved `@effect/vitest` from `dependencies` to an optional peer and marked `vitest` optional (`050a30f89f`); its `exports` and `publishConfig.exports` are untouched and the repo-contract suite still passes. `scripts/BUILD.ts` gained the `npmDedupe` and `npmDedupeUnit` targets. `known-files.d.ts` was regenerated twice (`d7c5a3e503`, `cd14388ed7`) and is current.

## Concurrency in the shared checkout

This gate did not have the checkout to itself. `run4/concurrent-builder.txt`, `run4/dist-provenance.txt`, and `run4/release-build.log` record the other lanes:

- The consumer-fixtures lane ran `phase7/consumers/build-all.sh`, which executes the same `env -u SMITHERS_HOME corepack pnpm --dir packages/$d run build` recipe over `consumers/pack-order.txt` in this checkout. Its `consumers/build.log` places its `patterns` build at 12:02:46 to 12:02:53Z, the window in which this gate's serial pass reached `patterns` and hit `ENOTEMPTY` on `rmSync(dist)` (step 7), and its `registry` build at 12:04:10 to 12:04:14Z. That lane's loop is why 28 `dist` directories already existed when this gate's build started at 12:01:15Z.
- The migration-tool lane built `packages/migrate` at 12:02:00 to 12:02:33Z (`phase7/migration-tool-logs/bin-build.log`) and then ran `packages/migrate/dist/esm/flow/bin.js`.
- A further build wrote `registry`'s `dist/cjs/package.json` at 12:06:19Z; the lane was not identified. Step 14 rebuilt `registry` with this gate's own invocation before the final checks.
- Ten private packages (`build`, `chain`, `create-app`, `errors`, `evals`, `fs`, `integrations`, `scorers`, `targets`, `triggers`) hold `dist/esm` plus `tsconfig.tsbuildinfo` and no `dist/cjs`, the shape `tsc -b` and the graph's `lib` target produce. They are outside the published roster and outside this gate's assertions.
- vitest suites (`pnpm -r --no-bail run test`, `packages/flows`, `e2e` fault cases), `tsc -p tsconfig.test.json --noEmit` in `build-cli` and `cli`, `scripts/generate-docs-pages.mjs --check`, and the cli-e2e probes also had the checkout open. Host load ran between 28 and 87.

Why the verdict still holds: the final checks (step 15) read `dist/` trees that were written either by this gate's own build (`patterns`, `registry`, and the 37 packages whose markers fall inside this gate's serial window) or by the consumer lane's invocation of the identical `scripts/build.mjs` at the identical HEAD with the identical `node_modules`. Step 16 shows the recipe is byte-reproducible for every emitted file, so which invocation wrote a tree does not change its contents. `dist` and marker mtimes were identical before and after each check batch (steps 12 and 15), so no builder rewrote a tree while a check was reading it. This gate's own build exited 0 for every one of the 40 packages (39 in step 7, `patterns` in step 8), which is the claim "the release recipe produces the public artifacts at this HEAD".

Two `scripts/build.mjs` processes on one package in one checkout collide on `rmSync(dist)` with `ENOTEMPTY`. That is the same race the run3 evidence and the npm-pack gate recorded. A gate that asserts on `dist/` is not isolated from a concurrent build in the same checkout; give each such gate its own clone, or serialize them. Unchanged recommendation from run3.

## Follow-ups (not rc.0 blockers)

1. `smithers-build build '//packages/...'` runs the synthesized `lib` target, which is tsc only (`packages/targets/src/StandardPackage.ts` lines 109 to 119, `TsBuild.ts`), so it emits `dist/esm` and never `dist/cjs`. The tarball contents come from the per-package `scripts/build.mjs` that `release.yml` runs with `pnpm --recursive --if-present run build`. Established in run3 (its steps 6, 8, and 12) and unchanged here. Give the graph a target that runs `scripts/build.mjs` so both paths produce the same `dist/`.
2. `scripts/build.mjs` line 16 calls `rmSync(dist, { recursive: true, force: true })` with no `maxRetries`, so a concurrent writer surfaces as a hard `ENOTEMPTY`. For the build-system owner.
3. Phase 7 lanes share one clean checkout; the interleaving recorded above cost this gate one spurious failure and two rebuilds. Per-gate clones remove the class of problem.

## Verdict

PASS. At `cd14388ed7`, from the clean checkout with `vendor/jj` initialized: `lint '//:knownFiles'` exits 0 at the start and the end of the gate; `known-files.d.ts` regenerates to itself through the read-only render and the in-place generator (zero diff, sha256 `01708e32...` unchanged, zero `vendor/jj` entries); `lint '//:tsconfig'` exits 0; both exports maps agree with each other and with the files on disk for all 40 published packages; every public `dist/esm/*.d.ts`, `dist/esm/*.js`, and `dist/cjs/*.js` exists after the release build recipe, which this gate's own invocation completed for 40 of 40 packages; all 581 public subpaths resolve and all 155 blocked subpaths refuse under Node require, Node import, and Bun, twice; the repo-contract suite passes 12 of 12; the emitted artifacts are byte-reproducible; and the tree is clean with no tracked `.d.ts` changed. The single change in the export surface since the superseded run is one new blocked `internal/` module, which the contract permits.
