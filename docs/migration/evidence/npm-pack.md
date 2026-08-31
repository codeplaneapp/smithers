# Phase 7 gate: npm-pack

Verdict: PASS

PLAN.md Phase 7 requirement: "npm pack/dry-run inspection for every public package." The repository pack-release dry run is the primary path because it is the only path that produces the tarballs a publish ships: `scripts/pack-release.mjs` stages each package in a temporary copy, rewrites `exports` from `publishConfig.exports` (pnpm keeps the source-first `exports` map otherwise), drops `node_modules`, `coverage`, `.smithers`, and `*.tsbuildinfo` from the copy, and runs `pnpm pack --json --config.ignore-scripts=true`. Packing without publishing is the dry run; publishing stays a manual maintainer action (PLAN.md "Release artifacts"). `npm pack --dry-run --json` was also run in every public workspace directory as a cross-check of the `files` globs against the release tarballs.

This run supersedes the earlier `npm-pack.md` written against `clean-checkout` at `9c464343f0`. Every number below is from `clean-checkout-2` at `20b32c6316`.

## Environment

| Item | Value |
| --- | --- |
| Checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-2`, branch `v1/rc0-migration`, HEAD `20b32c6316487497301db74ec70cbe951428ef53` (committed 2026-08-30T23:33:28-07:00), `vendor/jj` submodule at `47589ada70` |
| Working tree | `git status --porcelain` empty before and after the gate; `legacy/` absent |
| Node | v24.18.0 (`/Users/williamcory/.nvm/versions/node/v24.18.0/bin/node`) |
| pnpm | 11.21.0 via corepack (`packageManager: pnpm@11.21.0`) |
| npm | 11.16.0 (cross-check only) |
| Bun | 1.4.0 (not used by this gate) |
| Host | macOS 26.2 (25C56) arm64 |
| Date | 2026-08-31 (06:58 to 07:20 UTC) |
| Logs and scripts | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/phase7/npm-pack-logs/` |

## Commands

All commands ran with `cwd` at the checkout root and `env -u SMITHERS_HOME`.

| Step | Command | Exit | Final output |
| --- | --- | --- | --- |
| 1 | `git status --porcelain \| wc -l` | 0 | `0` |
| 2 | `node scripts/pack-release.mjs --names` | 0 | 40 names in publication order (`@smthrs/canonical` first, `@smthrs/cli` last). The script's roster check against rc-contract.md section 3.1 runs at import time and throws on any mismatch, so exit 0 is the roster proof. |
| 3 | `corepack pnpm -r --no-bail --if-present run build` | stopped | 47 `build: Done`; `packages/agent build: Failed` with `ENOTEMPTY ... packages/agent/dist` at `rmSync` (`packages/agent/scripts/build.mjs:16`); then `apps/ui build` blocked on `[electrobun] Waiting for the project build lock...`. See "Build state" below. Log: `npm-pack-logs/npm-pack-build-cc2.log`. |
| 4 | `node npm-pack-logs/check-built.mjs <checkout>` (the `assertBuilt` invariant from `pack-release.mjs`, reported per package) | 0 | `complete: 40/40` |
| 5 | `node scripts/pack-release.mjs <scratch>/release-packs-cc2` | 0 | silent; 40 `.tgz` plus `manifest.json`; ran 07:03:05Z to 07:03:46Z. An identical run at 07:02:11Z to 07:02:39Z also produced 41 files; the script deletes every `.tgz` and `manifest.json` before packing, so the verified directory is wholly the output of the second run. Log: `npm-pack-logs/pack-release-cc2.log` (0 bytes). |
| 6 | `node npm-pack-logs/verify-tarballs.mjs release-packs-cc2 tarball-summary-cc2.json` | 0 | `tarballs on disk: 40; manifest entries: 40; other files: []; manifest matches disk: true` then `failures: 0`. Log: `npm-pack-logs/verify-tarballs-cc2.log`; results: `npm-pack-logs/tarball-summary-cc2.json`. |
| 7 | `node npm-pack-logs/npm-dry-run.mjs <checkout> release-packs-cc2 npm-dry-run-cc2.json` (`npm pack --dry-run --json --ignore-scripts` in each of the 40 workspace directories, file list compared with the release tarball) | 1 | `packages: 40; mismatching packages: 2`. Every `npm pack --dry-run` exited 0 at version `1.0.0-rc.0`; 38 file sets are identical to the release tarballs; `@smthrs/canonical` and `@smthrs/observability` differ by exactly one extra npm entry, `package/dist/tsconfig.tsbuildinfo`. See "Observations". |
| 8 | `shasum -a 256 *.tgz \| sort` | 0 | 40 lines, `npm-pack-logs/tarball-shasums-cc2.txt`; SHA-256 of that file: `eac5bb9b2ca2a168d5d22ece1f2943a4da482aefc68661e88c032a45f60d7ba7` |
| 9 | `git status --porcelain \| wc -l` | 0 | `0` |

### Build state

The pack needs `dist/esm` (tsc) and `dist/cjs` (esbuild) for every source module; `pack-release.mjs` `assertBuilt` refuses to pack otherwise. Step 3 ran while other Phase 7 lanes used the same clean checkout (seven distinct lane commands were visible in `ps`): the consumer-fixtures lane was building the 40 public packages one at a time in publication order (`corepack pnpm --dir packages/<d> run build`, log `phase7/consumers/build.log`, `start 2026-08-31T06:58:18Z`), the exports-types-sync lane was running `smithers-build build '//packages/...' --jobs 4` (`tsc -b` emits into the same `dist/`), and vitest, electrobun `prepare`, and lint lanes were active. The `packages/agent` failure is a concurrent `rmSync(dist)` racing the consumer lane's build of the same package (`== agent 07:01:12` in its log). `apps/ui build` waited on an electrobun lock held by another lane's `electrobun prepare` (27 minutes old); the step was stopped because `apps/ui` is private and outside this gate. The consumer lane finished with `ALL_BUILDS_OK 2026-08-31T07:01:56Z`, after which step 4 confirmed every one of the 40 packages has `dist/esm/<m>.js`, `dist/esm/<m>.d.ts`, and `dist/cjs/<m>.js` for every `src/**/*.ts`, and step 5 packed from that state. The tarball-completeness check in step 6 re-proves the same invariant on the final artifacts, so the shared-checkout race cannot have produced a partial tarball.

## Roster

`manifest.json` lists exactly 40 tarballs, matching rc-contract.md section 3.1 (39 `@smthrs/*` names plus the unscoped `smthrs` deprecation notice). `readWorkspaceManifests()` throws when the set of non-private `{engine, agent}` manifests differs from `publishedPackages`. The 14 non-public workspace packages (`@smthrs/{build,build-cli,build-infra,chain,create-app,errors,evals,fs,integrations,scorers,targets,triggers,ui,ui-styleguide}`, plus every `apps/*`, `examples`, and `e2e` manifest) carry `private: true` and were not packed. The output directory holds 41 files: 40 `.tgz` plus `manifest.json`, nothing else.

## Per-tarball verification

`verify-tarballs.mjs` opened every tarball (`tar -tzf`), read its inner `package.json` (`tar -xOzf`), and checked the following. All 40 passed every check (`failures: 0`).

- Sources: at least one `package/src/**/*.ts`; for every shipped source module the matching `package/dist/esm/<module>.js`, `package/dist/esm/<module>.d.ts`, and `package/dist/cjs/<module>.js` are present. 4,694 entries and 9,541,930 bytes across the 40 tarballs.
- Root files: `package/package.json`, `package/LICENSE`, `package/README.md` present in all 40. `CHANGELOG.md` present in 37 tarballs. `@smthrs/canonical` and `@smthrs/observability` do not list one in `files` and have none; `@smthrs/notifications` lists `CHANGELOG.md` in `files` but `packages/notifications/CHANGELOG.md` does not exist, so its tarball ships none (observation 3).
- Inner manifest: `version` is `1.0.0-rc.0`; `exports["."]` points at `./dist/esm/...` (rewritten from `publishConfig.exports`); `publishConfig.exports` removed; `publishConfig.tag` is `rc` (ruling R-40); no `private` flag; no `workspace:` range and no `@smthrs/*` range other than exact `1.0.0-rc.0` in `dependencies`, `peerDependencies`, or `optionalDependencies`; every `bin` target exists in the tarball.
- Migrations: `@smthrs/journal` (`0001_initial.ts`, `0002_checkpoints.ts`), `@smthrs/run-store` (`0001_initial.ts`, `0002_lineage.ts`), `@smthrs/plan` (`0001_initial.ts`), `@smthrs/engine-store` (`0001_initial.ts`, `0002_selection_store.ts`), and `@smthrs/step-cache` (`0001_initial.ts`) ship `package/src/migrations/*.ts` with the same count of compiled `dist/esm/migrations/*.js` and `dist/cjs/migrations/*.js`. `@smthrs/memory` ships its schema as 12 `CREATE TABLE|VIRTUAL TABLE|INDEX` statements compiled into `dist/{esm,cjs}/internal/Sql.js`; the three `packages/memory/src/migrations/*.sql` files are documentation mirrors of those statements (`src/internal/Sql.ts:62`), no code references them, and `packages/memory/src` contains no `node:fs` import, so their exclusion by the `src/**/*.ts` glob (0 `.sql` entries in the tarball) changes nothing at runtime.
- Assets: `@smthrs/jj` ships `package/wasm/flows_jj.wasm`; `@smthrs/cli` ships `package/bin/smithers.mjs` (the `smithers` bin) and `package/docs/{SKILL.md,llms.txt,llms-full.txt}`; `@smthrs/migrate` ships its `smithers-migrate` bin target `package/dist/esm/flow/bin.js`; `THIRD_PARTY_NOTICES.md` is present in `@smthrs/engine`, `@smthrs/flow`, and `@smthrs/jj`, and `VENDOR.md` in `@smthrs/engine` (contract section 3.1, "where present").
- Forbidden content: zero entries under `package/test/`, zero entries with a `legacy`, `node_modules`, `coverage`, or `.smithers` path segment, zero `.tsbuildinfo` or `.env` entries. A structural sweep found zero entries outside `package/{src,dist,bin,docs,wasm}/` and the root files `package.json`, `LICENSE`, `README.md`, `CHANGELOG.md`, `THIRD_PARTY_NOTICES.md`, `VENDOR.md`. A separate `grep -E "^package/test/|/legacy/|/node_modules/"` over every tarball's entry list matched nothing.

Sanctioned `test` content, for the record: 15 helper modules under `src/test/` in ten packages (`control/TestControl`, `database/{DurableObjectStorageFake,TestDatabase}`, `engine-store/TestStores`, `gateway/TestSuperviseRuntime`, `journal/{Notifying,TestJournal}`, `kernel/{HostContract,TestGrantStore,TestHost}`, `memory/TestMemory`, `run-store/TestRunStore`, `step-cache/TestCacheStore`, `sync/{TestSocket,TestSync}`), with their `dist` builds. They live under `src/`, are reached through the `./*` export, and rc-contract.md section 3.1 names them part of the public surface. No package's `test/` spec directory is in any tarball.

The `smthrs` deprecation tarball contains exactly 11 entries: `src/index.ts`, its esm and cjs builds with maps and `index.d.ts`, `LICENSE`, `README.md`, `CHANGELOG.md`, and `package.json` with `exports` limited to `.`, no `bin`, `smthrs.group: "agent"`, and `publishConfig.tag: "rc"` (contract section 3.3).

### Old-name string scan

Every `.js`, `.mjs`, `.cjs`, `.ts`, `.json`, `.md`, and `.txt` entry in all 40 tarballs was scanned for `smithers-orchestrator`, `smthrs/jsx-runtime`, and `jsxImportSource: smthrs`. Hits, all in content whose job is to name the 0.x surface:

- `@smthrs/migrate`: `Constructs`, `Detect`, `Inventory`, `Mapping`, `flow/Archive` (source, esm, cjs, d.ts). These are the detection and rewrite tables; the tool must name the 0.x packages to migrate them. No import statement references them.
- `smthrs`: `README.md`, the removed-API list the contract requires (section 3.3).
- `@smthrs/cli`: `docs/llms-full.txt` only (`docs/llms.txt` and `docs/SKILL.md` have zero hits). Six lines: two copies of the rc-contract.md section 11 compatibility-promise sentence, which itself names `smthrs/jsx-runtime`, and four rows of the migrate-tool tables in the migration guide (`@jsxImportSource smithers-orchestrator`, `smthrs/jsx-runtime`). `scripts/generate-llms.ts` renders this file from `docs/pages`, and `phase7/scans.md` section 4.1 already classifies `packages/cli/docs/llms-full.txt` as migration guidance rather than a live import. The same six lines were present at `9c464343f0`; the earlier `npm-pack.md` missed them because its scan omitted `.txt` entries. Its statement "No other tarball contains any of the strings" was wrong for `@smthrs/cli`. The ruling on whether contract-mandated wording inside a shipped docs bundle satisfies "any hit fails the release" belongs to the scans gate, which owns that sweep; it does not change what this gate measures.

## Tarballs

Publication order from `manifest.json`. Byte counts differ from the `9c464343f0` run for `engine-store`, `control`, `gateway`, `agent`, and `cli`, the packages the 48 intervening commits touched.

| Package | Tarball | Entries | Bytes |
| --- | --- | --- | --- |
| `@smthrs/canonical` | `smthrs-canonical-1.0.0-rc.0.tgz` | 25 | 9,724 |
| `@smthrs/capability` | `smthrs-capability-1.0.0-rc.0.tgz` | 26 | 29,676 |
| `@smthrs/crypto` | `smthrs-crypto-1.0.0-rc.0.tgz` | 19 | 5,923 |
| `@smthrs/artifacts` | `smthrs-artifacts-1.0.0-rc.0.tgz` | 54 | 102,759 |
| `@smthrs/core` | `smthrs-core-1.0.0-rc.0.tgz` | 96 | 124,738 |
| `@smthrs/database` | `smthrs-database-1.0.0-rc.0.tgz` | 82 | 87,950 |
| `@smthrs/jj` | `smthrs-jj-1.0.0-rc.0.tgz` | 63 | 1,459,918 |
| `@smthrs/journal` | `smthrs-journal-1.0.0-rc.0.tgz` | 96 | 150,862 |
| `@smthrs/keys` | `smthrs-keys-1.0.0-rc.0.tgz` | 20 | 6,237 |
| `@smthrs/migrate` | `smthrs-migrate-1.0.0-rc.0.tgz` | 222 | 796,432 |
| `@smthrs/notifications` | `smthrs-notifications-1.0.0-rc.0.tgz` | 60 | 67,390 |
| `@smthrs/observability` | `smthrs-observability-1.0.0-rc.0.tgz` | 67 | 28,119 |
| `@smthrs/patterns` | `smthrs-patterns-1.0.0-rc.0.tgz` | 215 | 254,684 |
| `@smthrs/plan` | `smthrs-plan-1.0.0-rc.0.tgz` | 103 | 189,349 |
| `@smthrs/flow` | `smthrs-flow-1.0.0-rc.0.tgz` | 335 | 403,190 |
| `@smthrs/engine` | `smthrs-engine-1.0.0-rc.0.tgz` | 91 | 118,776 |
| `@smthrs/plugin` | `smthrs-plugin-1.0.0-rc.0.tgz` | 61 | 38,601 |
| `@smthrs/run-store` | `smthrs-run-store-1.0.0-rc.0.tgz` | 75 | 128,667 |
| `smthrs` | `smthrs-1.0.0-rc.0.tgz` | 11 | 4,219 |
| `@smthrs/step-cache` | `smthrs-step-cache-1.0.0-rc.0.tgz` | 61 | 58,910 |
| `@smthrs/sync` | `smthrs-sync-1.0.0-rc.0.tgz` | 152 | 170,819 |
| `@smthrs/kernel` | `smthrs-kernel-1.0.0-rc.0.tgz` | 138 | 192,436 |
| `@smthrs/engine-store` | `smthrs-engine-store-1.0.0-rc.0.tgz` | 285 | 927,197 |
| `@smthrs/model` | `smthrs-model-1.0.0-rc.0.tgz` | 138 | 243,119 |
| `@smthrs/memory` | `smthrs-memory-1.0.0-rc.0.tgz` | 117 | 151,500 |
| `@smthrs/platform-browser` | `smthrs-platform-browser-1.0.0-rc.0.tgz` | 124 | 47,688 |
| `@smthrs/platform-node` | `smthrs-platform-node-1.0.0-rc.0.tgz` | 40 | 111,552 |
| `@smthrs/platform-bun` | `smthrs-platform-bun-1.0.0-rc.0.tgz` | 26 | 9,778 |
| `@smthrs/registry` | `smthrs-registry-1.0.0-rc.0.tgz` | 96 | 187,407 |
| `@smthrs/control` | `smthrs-control-1.0.0-rc.0.tgz` | 180 | 332,369 |
| `@smthrs/gateway` | `smthrs-gateway-1.0.0-rc.0.tgz` | 82 | 99,391 |
| `@smthrs/harness` | `smthrs-harness-1.0.0-rc.0.tgz` | 222 | 759,969 |
| `@smthrs/mcp` | `smthrs-mcp-1.0.0-rc.0.tgz` | 47 | 31,051 |
| `@smthrs/sandbox` | `smthrs-sandbox-1.0.0-rc.0.tgz` | 250 | 75,641 |
| `@smthrs/std` | `smthrs-std-1.0.0-rc.0.tgz` | 313 | 397,341 |
| `@smthrs/agent` | `smthrs-agent-1.0.0-rc.0.tgz` | 145 | 472,957 |
| `@smthrs/testing` | `smthrs-testing-1.0.0-rc.0.tgz` | 194 | 286,496 |
| `@smthrs/time-travel` | `smthrs-time-travel-1.0.0-rc.0.tgz` | 131 | 231,839 |
| `@smthrs/flows` | `smthrs-flows-1.0.0-rc.0.tgz` | 26 | 45,321 |
| `@smthrs/cli` | `smthrs-cli-1.0.0-rc.0.tgz` | 206 | 701,935 |

Scratch copies of the tarballs: `/private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/release-packs-cc2`. Reproduce with steps 4 and 5; compare against `npm-pack-logs/tarball-shasums-cc2.txt`.

## Observations (not blockers)

1. `@smthrs/canonical` and `@smthrs/observability` declare `files: ["src/**/*.ts", "dist/**/*", "LICENSE", "README.md"]`; the other 38 public manifests use the explicit allowlist (`dist/**/*.js`, `dist/**/*.js.map`, `dist/**/*.d.ts`, `dist/**/*.d.ts.map`, `dist/**/package.json`). `tsc -b tsconfig.json` (the `check` script) writes `dist/tsconfig.tsbuildinfo`, and `npm pack --dry-run` from the workspace directory includes it for these two packages (102 and 210 bytes). The release tarballs are clean because `pack-release.mjs` `copyFilter` drops `*.tsbuildinfo` from the staging copy, and `release.yml` publishes those tarballs. A maintainer who ran `pnpm publish` from either directory after a `check` would ship the file. Follow-up for a fix lane: align the two `files` arrays with the other 38.
2. `pnpm -r run build` is not safe to run while another lane builds in the same checkout: every `scripts/build.mjs` starts with `rmSync(dist)`, so two builders of one package race to `ENOTEMPTY`. This gate worked around it (steps 3 and 4); the phase 2 baseline's note that no target declares the esbuild `dist/cjs` step still stands.
3. `@smthrs/notifications` declares `CHANGELOG.md` in `files` but has no such file, so it is the one public package with a changelog entry in `files` and no changelog in its tarball. LICENSE and README, the files this gate requires, are present. Follow-up for a fix lane: add the changelog or drop the entry.

## Verdict

PASS. `pack-release.mjs` packed all 40 public packages at `1.0.0-rc.0` in dependency order with exit 0 from the clean checkout at `20b32c6316`. Every tarball ships its sources with complete esm, cjs, and d.ts builds, its migrations (compiled, plus the `src/migrations` TypeScript sources where they exist), its assets (jj wasm, CLI bin shim and docs, migrate bin, third-party notices), LICENSE, and README, and no tarball contains anything from a `test/` spec directory, `legacy/`, or `node_modules`. `npm pack --dry-run` agrees with the release tarballs on 38 of 40 file sets and differs only by a `tsbuildinfo` the release path strips.
