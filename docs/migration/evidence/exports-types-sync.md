# Phase 7 gate: exports-types-sync

Verdict: PASS

This file supersedes the 2026-08-31 06:58 to 07:05 UTC run taken at `20b32c6316` in `migration/clean-checkout-2`, which recorded FAIL solely because `known-files.d.ts` was stale. That run's blocker is closed: `163fdf4bf5` (`chore(build): regenerate known-files.d.ts for the files the UI commit added`) is the only commit after `20b32c6316` and touches only `known-files.d.ts`. The committed file is byte-identical to the regenerated form that run predicted (`exports-types-sync/run2/known-files.regenerated.d.ts`, 4653 files, 11398 lines). At `163fdf4bf5` the required CI step `lint '//:knownFiles'` exits 0, regeneration is idempotent with `vendor/jj` initialized, and the package export/type synchronization contract holds for all 40 published packages under Node (require and import conditions) and Bun on freshly built public artifacts.

This run also corrects two statements in the superseded file; see "Corrections to the prior evidence".

## Gate definition

- PLAN.md Phase 7 requires "package export/type synchronization checks"; Phase 3 defines the claims: "exports resolve in Node, Bun, and supported browser builds" and "public types are generated and current". Browser resolution is the separate `browser-bundling` gate.
- `docs/migration/rc-contract.md` section 3.5: the wildcard surface is the contract, `./internal/*` and `./*/index` stay null in both `exports` and `publishConfig.exports`, and "the Phase 7 export/type synchronization gate resolves every non-null subpath above under Node and Bun".
- rc-contract section 9 (CI lanes) and the root `BUILD.ts` at HEAD (line 146) make `lint '//:knownFiles'` ("Known-file registry drift") a step of the required `test` job; `.github/workflows/ci.yml` lines 89 to 93 carry it. `known-files.d.ts` is the only committed `.d.ts` a generator owns (`BUILD.ts` line 12, `Smithers.Generate` over `scripts/generate-known-files.mjs`, `changes: ["known-files.d.ts"]`). The other nine tracked declaration files are hand-written ambient declarations, template files, or test fixtures (step 17 lists them).
- rc-contract section 9 (Build system): per-package `scripts/build.mjs` emits tsc declarations to `dist/esm` and esbuild CJS to `dist/cjs`; `.github/workflows/release.yml` step "Build all workspaces from clean artifacts" runs `pnpm --recursive --if-present run build` after deleting every `packages/**/dist`.

## Environment

| Item | Value |
| --- | --- |
| Host | macOS 26.2 (Darwin 25.2.0), arm64 |
| Node | v24.18.0 |
| Bun | 1.4.0-canary.1+6618e7f7e (`bun --version` prints `1.4.0`) |
| pnpm | 11.21.0 (corepack 0.35.0, from `packageManager`) |
| Checkout | /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-3 |
| HEAD | `163fdf4bf55bb86984a0b3cf9ddf4b0d7e836c5c` (v1/rc0-migration), `git status --porcelain` empty before and after the gate |
| Submodule | `vendor/jj` initialized at `47589ada70c12b3e829b5c98ab32503abad49eac` (`v0.25.0-3759-g47589ada7`) |
| Install | frozen pnpm and Bun installs from `00-clean-install.md`; no `packages/*/dist` existed before this gate (`ls -d packages/*/dist` matched nothing) |
| apps/ui devkit | `apps/ui/.hutch/devkit` is a projection copied from the maintainer checkout (`projection.json`: electrobun 2.0.1, macos arm64), git-ignored by `apps/ui/.gitignore:35`, because `electrobun prepare` blocks on a hutch lock another session holds. This gate never touches `apps/ui`; the state is recorded as the documented setup |
| Date | 2026-08-31 07:27:11 to 07:33:28 UTC (00:27 to 00:33 PT) |
| Host load | 16.30 at gate start (00:25 PT), 8.27 before the graph build, 12.89 after it, 4.39 before the release build, 14.00 after it, 10.03 at the final checks. `uptime` was read before each long step; no step ran above load 40 |

`SMITHERS_HOME` was unset (`env -u SMITHERS_HOME`) for every command. All commands ran from the checkout root in the foreground. Harness sources are in `exports-types-sync/` beside this file and are unchanged from the prior two runs (`exports-sync-check.mjs`, `exports-import-resolve.mjs`, `exports-bun-resolve.ts`). Every log from this run is in `exports-types-sync/run3/`.

## Commands and results

| # | Command | Exit | Final output |
| --- | --- | --- | --- |
| 1 | `pnpm exec smithers-build lint '//:knownFiles'` (07:27:11Z) | 0 | `//:knownFiles ran 675ms`, `1 targets: 0 hit, 1 ran, 0 failed, 0 skipped`, `ok: true` (`run3/lint-knownfiles.out`) |
| 2 | read-only render: `node run3/render-known-files.mjs > run3/known-files.regenerated.d.ts`, then `diff known-files.d.ts run3/known-files.regenerated.d.ts` | render 0, diff 0 | 11398 lines tracked, 11398 regenerated, empty diff (`run3/known-files.diff` is 0 bytes, `run3/known-files.render.err` is 0 bytes). The regenerated file contains zero `vendor/jj` entries with the submodule initialized |
| 3 | `pnpm exec smithers-build lint '//:tsconfig'` | 0 | `//:tsconfig Tsconfig ran`, `ok: true` (`run3/lint-tsconfig.out`) |
| 4 | `node scripts/pack-release.mjs --list` | 0 | 40 workspace directories in publication order, `canonical` first, `cli` last (`run3/pack-release-list.out`); the script throws at import time unless the non-private engine/agent manifest set equals the rc-contract section 3.1 roster |
| 5 | `pnpm exec smithers-build build '//:knownFiles'` | 1 | `code: build_failed`, `message: "target selected by //:knownFiles does not support the build verb"` (`run3/build-knownfiles.out`). `Smithers.Generate` supports `lint` and `run`, not `build`; the file was untouched (sha256 `462fbccf...` before and after). Recorded to correct the prior evidence; the regeneration path is step 7 |
| 6 | `pnpm exec smithers-build build '//packages/...' --jobs 4` (07:27:34Z to 07:28:57Z) | 0 | `103 targets: 0 hit, 103 ran, 0 failed, 0 skipped (78.8s)`, `ok: true` (`run3/build-packages.log`). Afterwards 51 `packages/*/dist` directories existed and zero `packages/*/dist/cjs` directories |
| 7 | in-place regeneration: `node scripts/generate-known-files.mjs` (07:29:21Z) | 0 | sha256 of `known-files.d.ts` unchanged (`462fbccf18c732109ebbb2402121ad61a1a96280376ce0f02fefe75dbb472662` before and after), `git diff --quiet -- known-files.d.ts` exit 0, `git status --porcelain` empty, 11398 lines (`run3/generate-known-files.out`). The generator is idempotent at this HEAD with `vendor/jj` initialized |
| 8 | `node exports-sync-check.mjs <root> run3/exports-expectations.json` (07:29:21Z, after step 6 only) | 1 | `packages checked: 40`, `FAILURES (581)`: every one of the 581 public subpaths reports `publish target ./dist/cjs/<m>.js is missing`, plus 40 `dist/cjs/package.json marker missing` (`run3/sync-check.out`). No other failure class. See "Which build emits the publish artifacts" |
| 9 | `node --experimental-import-meta-resolve exports-import-resolve.mjs run3/exports-expectations.json` | 0 | `node import-condition: 581 subpaths resolved, 154 blocked subpaths refused` / `exports-import-resolve: OK` (`run3/import-resolve.out`) |
| 10 | `bun exports-bun-resolve.ts run3/exports-expectations.json` | 0 | `bun: 581 subpaths resolved, 154 blocked subpaths refused` / `exports-bun-resolve: OK` (`run3/bun-resolve.out`) |
| 11 | `node --test scripts/repo-contract/package-contract.test.mjs scripts/repo-contract/barrels.test.mjs` | 0 | `tests 12`, `suites 4`, `pass 12`, `fail 0` (`run3/repo-contract.out`) |
| 12 | step 8 repeated (07:29:49Z) | 1 | identical failure set (`run3/sync-check-2.out`). `packages/time-travel/dist` held only `esm/` and `tsconfig.tsbuildinfo`; `ps` and `lsof` showed no builder touching the checkout, so the failure is deterministic, not a race |
| 13 | release build recipe, serial in publication order: `for d in $(pack-release --list); do corepack pnpm --dir packages/$d run build; done` (07:31:17Z to 07:33:00Z) | 0 for all 40 | 40 `== <dir> exit=0` lines, 1 to 6 s each (`run3/release-build.log`); afterwards 40 `packages/*/dist/cjs` directories, `git status --porcelain` empty |
| 14 | `node exports-sync-check.mjs <root> run3/exports-expectations-3.json` (07:33:24Z) | 0 | `packages checked: 40` ... `exports-sync-check: OK` (`run3/sync-check-3.out`) |
| 15 | `node --experimental-import-meta-resolve exports-import-resolve.mjs run3/exports-expectations-3.json` | 0 | `node import-condition: 581 subpaths resolved, 154 blocked subpaths refused` / `exports-import-resolve: OK` (`run3/import-resolve-3.out`) |
| 16 | `bun exports-bun-resolve.ts run3/exports-expectations-3.json` | 0 | `bun: 581 subpaths resolved, 154 blocked subpaths refused` / `exports-bun-resolve: OK` (`run3/bun-resolve-3.out`) |
| 17 | `pnpm exec smithers-build lint '//:knownFiles'` (end of gate, 07:33:25Z) | 0 | `//:knownFiles ran 1.1s`, `ok: true` (`run3/lint-knownfiles-end.out`). `git status --porcelain` empty, `git ls-files --others --exclude-standard` empty, HEAD still `163fdf4bf5`. Tracked `.d.ts` files: `apps/ui/src/mainview/vite-env.d.ts`, `known-files.d.ts`, `packages/build-cli/src/effect-resolution.d.ts`, two `packages/build-cli/test/fixtures/*/smithers.d.ts`, two `packages/create-app/template/*/virtual.d.ts`, `packages/harness/test/workerd/wasm.d.ts`, `packages/migrate/test/fixtures/jsx-single/mdx-assets.d.ts`, `scripts/package-api-sweep.d.mts`; none changed |

Cross-run identity: `run3/exports-expectations.json` (step 8) and `run3/exports-expectations-3.json` (step 14) are byte-identical, and after substituting the checkout path they are byte-identical to `run2/exports-expectations.json` from `20b32c6316`. The per-package summary lines of `run3/sync-check-3.out` equal those of `run2/sync-check-2.out`. No public package changed its export surface between `20b32c6316` and `163fdf4bf5`, which matches the one-file diff between the commits.

## What the harness proves

`exports-sync-check.mjs` scans every non-private `packages/*` manifest whose `smthrs.group` is `engine` or `agent` (40 packages, the rc-contract section 3.1 roster, all at `1.0.0-rc.0`) and asserts, per package:

1. `exports` and `publishConfig.exports` carry identical key sets, and a key is null in one map exactly when it is null in the other (`./internal/*` and `./*/index` stay blocked in both).
2. Every concrete non-null `exports` target exists on disk, and none points into `src/internal/`.
3. Every concrete non-null `publishConfig.exports` entry declares `types`, `import`, and `require`, and all three files exist under `dist/`.
4. Every module under `src/**/*.ts`, pushed through the Node exports-pattern precedence (exact key, then longest wildcard prefix, then longest suffix), lands on a real target or on a deliberate null. For every resolvable module the built trio exists: `dist/esm/<m>.js`, `dist/esm/<m>.d.ts`, `dist/cjs/<m>.js`. Step 13 (a fresh release build at HEAD, 40 of 40 exit 0) is what makes this "public types generated and current".
5. Wherever a `require` target lives under `dist/cjs/`, `dist/cjs/package.json` exists and declares `"type": "commonjs"`.
6. Every declared `bin` file exists (including `@smthrs/migrate`'s `dist/esm/flow/bin.js`).
7. Require-condition resolution: every public subpath resolves via Node self-reference to exactly the file the exports map names (realpath equality), and every null subpath throws `ERR_PACKAGE_PATH_NOT_EXPORTED`.

Steps 9, 10, 15, and 16 rerun the same 581 public and 154 blocked subpaths under the Node import condition and under Bun (`Bun.resolveSync`) with identical results. Those stages read only the `exports` maps and `src/`, which is why they pass in steps 9 and 10 before the release build. The repo-contract suite (step 11) adds the manifest contract (one release version, publishable surface, `rc` dist-tag, exact sibling pins, no published-to-private edges) and the `@smthrs/flows` barrel runtime check.

`known-files.d.ts` is proven current three ways at this HEAD: the CI drift target (steps 1 and 17), a read-only render through `discoverKnownFiles` and `renderKnownFileDeclaration` from `packages/targets/src/KnownFile.ts` (step 2), and the real generator writing in place with no resulting diff (step 7). All three ran with `vendor/jj` initialized and produced zero `vendor/jj` entries, so the submodule boundary fix from the known-files lane holds.

## Which build emits the publish artifacts

`pnpm exec smithers-build build '//packages/...'` runs each package's synthesized `lib` target. `packages/targets/src/StandardPackage.ts` lines 109 to 119 define `lib` as `TsBuild({ tool: { name: "tsc" }, format: "dual", outDir: "dist", ... })`, and `TsBuild.ts` runs only `tsc`; the package tsconfig owns every emit option (`outDir: "dist/esm"`, `declaration: true`). The `format: "dual"` attr feeds `PackageJson` entry-point derivation and does not add a CJS emit. Steps 6, 8, and 12 measure this directly: after the graph build every package has `dist/esm/*.js` and `dist/esm/*.d.ts` and none has `dist/cjs`, so the `require` condition of every `publishConfig.exports` entry has no file.

The build that produces the tarball contents is the per-package `scripts/build.mjs` (`rmSync(dist)`, `tsc -p tsconfig.json`, esbuild to `dist/cjs`, `.ts` to `.js` require rewrite, `dist/cjs/package.json` marker), invoked by `pnpm --recursive --if-present run build` in `release.yml` and enforced by `pack-release.mjs` `assertBuilt` (line 243 checks `dist/cjs/<m>.js`). Step 13 ran that recipe serially in publication order because parallel builders of one package race on `rmSync` (the npm-pack gate hit `ENOTEMPTY` that way). With the release build in place every check passes (steps 14 to 16).

This gate therefore holds on the artifacts the publish workflow builds and packs. The graph build alone is not a substitute, which the phase 2 baseline and the npm-pack evidence already note ("no target declares the esbuild `dist/cjs` step"). Follow-up for the build-system owner, not a blocker for rc.0: give the graph a target that runs `scripts/build.mjs` (or an esbuild CJS step) so `smithers-build build '//packages/...'` and `pnpm -r run build` produce the same `dist/`.

## Corrections to the prior evidence

1. The superseded file stated that `lib` is `TsBuild` with `format: "dual"`, "so one build emits both `dist/esm` and `dist/cjs`", and credited its green sync check to `smithers-build build`. That inference was wrong. Its own "Concurrency in the shared checkout" section records that another lane rebuilt every `packages/*/dist` with per-package `scripts/build.mjs` during the gate, and the npm-pack evidence identifies that lane (the consumer-fixtures build, `ALL_BUILDS_OK 2026-08-31T07:01:56Z`). That concurrent release build is what supplied `dist/cjs`. This run isolates the two build paths (steps 6 to 8 and 12 to 14) and records the correct attribution.
2. The superseded file offered `pnpm exec smithers-build build '//:knownFiles'` as equivalent to `node scripts/generate-known-files.mjs`. The `Generate` target does not support the `build` verb (step 5). The regeneration command is `node scripts/generate-known-files.mjs`; the drift check is `smithers-build lint '//:knownFiles'`.

The phase 2 baseline's note that `lint '//:knownFiles'` "exits 1 while the generator produces no diff" is obsolete since the known-files lane (`71d2e259d2`, `1f80d6dd66`): the target runs, exits 0 on a current registry, and is a required CI step.

## Concurrency in the shared checkout

Other Phase 7 lanes ran `tsc -b` in `packages/{journal,jj,keys,step-cache,harness}` between 00:26 and 00:27 PT, before this gate's builds. During steps 8 to 16 no builder, vitest, or bun process outside this gate had the checkout open (`ps` filtered on the checkout path, `lsof +D packages/time-travel/dist`), `packages/time-travel/dist` kept its 00:27:13 mtime through step 12, and the `dist/cjs` files written in step 13 kept their 00:31:18 to 00:33:00 mtimes through step 16. The failures in steps 8 and 12 and the passes in steps 14 to 16 are therefore attributable to the build path and not to interference. A gate that asserts on `dist/` is still not isolated from a concurrent `pnpm -r run build` in the same checkout; serialize such gates or give each its own clone.

## Verdict

PASS. At `163fdf4bf5`, from the clean checkout with `vendor/jj` initialized: `lint '//:knownFiles'` exits 0 at the start and the end of the gate, `known-files.d.ts` regenerates to itself (read-only render and in-place generator, zero diff, zero `vendor/jj` entries), `lint '//:tsconfig'` exits 0, both exports maps agree with each other and with the files on disk for all 40 published packages, every public `dist/esm/*.d.ts`, `dist/esm/*.js`, and `dist/cjs/*.js` exists after the release build recipe, all 581 public subpaths resolve and all 154 blocked subpaths refuse under Node require, Node import, and Bun, the repo-contract suite passes 12 of 12, and the tree is clean with no tracked `.d.ts` changed. The single blocker of the superseded run is closed.
