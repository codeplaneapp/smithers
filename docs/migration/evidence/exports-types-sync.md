# Phase 7 gate: exports-types-sync

Verdict: FAIL

Package export/type synchronization is green across all 40 published packages: public types build cleanly and cover every public module, both exports maps agree with each other and with the files on disk, and every non-null subpath resolves under Node (require and import conditions) and Bun while every null subpath refuses. The gate fails on the repository's one committed generated declaration file: `known-files.d.ts` does not regenerate byte-identical in the documented clean setup, and its drift-check target `//:knownFiles` cannot execute at all.

## Gate definition

- PLAN.md Phase 7 requires "package export/type synchronization checks"; Phase 3 defines the claims: "exports resolve in Node, Bun, and supported browser builds" and "public types are generated and current". Browser resolution is the separate `browser-bundling` gate.
- `docs/migration/rc-contract.md` section 3.5 fixes the operational contract: the wildcard surface is the contract, `./internal/*` and `./*/index` stay null-blocked in both `exports` and `publishConfig.exports`, and "the Phase 7 export/type synchronization gate resolves every non-null subpath above under Node and Bun".

## Environment

| Item | Value |
| --- | --- |
| Host | macOS (Darwin 25.2.0), arm64 |
| Node | v24.18.0 |
| Bun | 1.4.0 |
| pnpm | 11.21.0 (corepack) |
| Checkout | /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout |
| HEAD | `9c464343f0cfada6aa36f0a08144ed7cf1f0ce14` (v1/rc0-migration), vendor/jj submodule initialized at `47589ada70` |
| Date | 2026-08-30 |

All commands ran from the clean checkout root. Harness sources, the expectations JSON, and full logs are beside this file in `exports-types-sync/`.

## Commands and results

| # | Command | Exit | Final output |
| --- | --- | --- | --- |
| 1 | `pnpm exec smithers-build build '//packages/...' --jobs 4` | 0 | `103 targets: 0 hit, 103 ran, 0 failed, 0 skipped (129.4s)`, `ok: true` (log: `exports-types-sync/build-packages.log`) |
| 2 | `node exports-sync-check.mjs <root> exports-expectations.json` | 0 | `packages checked: 40` ... `exports-sync-check: OK` (log: `exports-types-sync/sync-check.out`) |
| 3 | `node --experimental-import-meta-resolve exports-import-resolve.mjs exports-expectations.json` | 0 | `node import-condition: 581 subpaths resolved, 154 blocked subpaths refused` / `exports-import-resolve: OK` |
| 4 | `bun exports-bun-resolve.ts exports-expectations.json` | 0 | `bun: 581 subpaths resolved, 154 blocked subpaths refused` / `exports-bun-resolve: OK` |
| 5 | `node scripts/pack-release.mjs --list` | 0 | 40 workspace directories in publication order; the script itself throws unless the non-private engine/agent manifest set equals the rc-contract section 3.1 roster |
| 6 | `node --test scripts/repo-contract/package-contract.test.mjs scripts/repo-contract/barrels.test.mjs` | 0 | `tests 12`, `pass 12`, `fail 0` |
| 7 | `pnpm exec smithers-build lint '//:tsconfig'` | 0 | `//:tsconfig Tsconfig ran`, `failed: 0`, `ok: true` (generated root tsconfig.json has no drift) |
| 8 | `pnpm exec smithers-build lint '//:knownFiles'` | 1 | `//:knownFiles failed 67ms {"_tag":"smithers-build/ExecError","argv":["{smthrs:tool:{\"_tag\":\"RuntimeBin\"}}","{smthrs:script://scripts/generate-known-files.mjs}"],...,"stderr":"spawn {smthrs:tool:{\"_tag\":\"RuntimeBin\"}} ENOENT"}` |
| 9 | `pnpm exec smithers-build run '//:knownFiles'` | 1 | Same ExecError; `1 of 1 targets failed` |
| 10 | `node scripts/generate-known-files.mjs && git diff --stat -- known-files.d.ts` | 0 | `known-files.d.ts | 1410 +++...+-` — 1409 insertions, all `//vendor/jj/**` entries; file header count changes 4598 to 5302. Reverted with `git checkout -- known-files.d.ts` |
| 11 | `git status --porcelain` (end of gate) | 0 | Empty. The build and the checks left every tracked file byte-identical |

## What the harness proves

`exports-sync-check.mjs` scans every non-private `packages/*` manifest whose `smthrs.group` is `engine` or `agent` (40 packages, the exact rc-contract section 3.1 roster) and asserts, per package:

1. `exports` and `publishConfig.exports` carry identical key sets, and a key is null in one map exactly when it is null in the other (the `./internal/*` and `./*/index` blocks survive in both maps).
2. Every concrete non-null `exports` target exists on disk, and none points into `src/internal/`.
3. Every concrete non-null `publishConfig.exports` entry declares `types`, `import`, and `require`, and all three files exist under `dist/`.
4. Every module under `src/**/*.ts`, pushed through the Node exports-pattern precedence (exact key first, then longest wildcard prefix, then longest suffix), lands either on a real target or on a deliberate null. For every resolvable module the built trio exists: `dist/esm/<m>.js`, `dist/esm/<m>.d.ts`, `dist/cjs/<m>.js`. With step 1 (a fresh full `smithers-build build` at HEAD, 0 failures) this is "public types generated and current".
5. Wherever a `require` target lives under `dist/cjs/`, the `dist/cjs/package.json` marker exists and declares `"type": "commonjs"`.
6. Every declared `bin` file exists (including `@smthrs/migrate`'s `dist/esm/flow/bin.js`, absent before the build).
7. Require-condition resolution: every public subpath resolves via Node self-reference to exactly the file the exports map names (realpath equality), and every null subpath throws `ERR_PACKAGE_PATH_NOT_EXPORTED`.

Steps 3 and 4 rerun the same 581 public and 154 blocked subpaths under the Node import condition and under Bun (`Bun.resolveSync`): identical results. The repo-contract suite (step 6) adds the manifest contract (one release version, publishable surface, exact sibling pins, no published-to-private edges) and the `@smthrs/flows` barrel runtime check (every listed namespace is exported and every exported namespace is listed, imported at runtime, plus a declared dependency for each).

Per-package subpath counts are in `exports-types-sync/sync-check.out`. The `shipped-but-unexported` column counts modules that ship in the tarball (`files: src/**`) but are deliberately null-blocked (for example `@smthrs/flow`'s `./Flow/*` internals); rc-contract section 3.5 makes the null entries the recorded intent, so these are informational.

## Blockers

1. `//:knownFiles` cannot execute. The root `BUILD.ts` Generate target (script form, `scripts/generate-known-files.mjs`) fails under both `smithers-build lint` and `smithers-build run` with `spawn {smthrs:tool:{"_tag":"RuntimeBin"}} ENOENT`: the RuntimeBin interpreter token in the planned argv is never substituted before spawn. This is the only `Smithers.Generate` usage in the tree, no CI job selects it (`.github/workflows/ci.yml` runs `ci '//packages/...'`, `test '//scripts/...'`, `lint '//:ci'`), and no test pins it, so the drift check for the one committed generated `.d.ts` runs nowhere. Reproduce: `pnpm exec smithers-build lint '//:knownFiles'` in the clean checkout.
2. `known-files.d.ts` drifts on regeneration in the documented setup. `node scripts/generate-known-files.mjs` in a checkout with the `vendor/jj` submodule initialized (the setup PLAN and CI use; `ci.yml` checks out with `submodules: recursive`, and the maintainer tree has it initialized at the same commit) rewrites the file from 4598 to 5302 entries, adding 704 `//vendor/jj/**` literals. `Input.discoverFiles` skips entries named `.git` (`packages/targets/src/Input.ts:647`) but never treats `vendor/jj` as a repository boundary, and `discoverKnownFiles` (`packages/targets/src/KnownFile.ts`) passes no `repositoryBoundaries`, so the walk descends into any materialized submodule. Either the walk must stop at submodule boundaries or the committed file is stale; as committed, the generated declaration is only reproducible from a checkout without the submodule. The experiment was reverted with `git checkout -- known-files.d.ts`; the tree is clean.

Nothing else failed. If the fix lane decides `known-files.d.ts` currency belongs to the separate "generated-file scans" gate, the package-level portion of this gate stands entirely green and the two blockers move with it.

## Verdict

FAIL. The package export/type synchronization contract holds for all 40 published packages under Node and Bun, but the gate's "no d.ts drift" clause does not: the committed generated declaration `known-files.d.ts` is not reproducible in the documented clean setup, and the build target that should check it cannot spawn.
