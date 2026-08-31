# Phase 7 gate: npm-pack

Verdict: PASS

PLAN.md Phase 7 requirement: "npm pack/dry-run inspection for every public package." The repository pack-release dry run was used instead of raw `npm pack --dry-run` because the release path packs each package from a staged copy whose `exports` map is rewritten from `publishConfig.exports` (`scripts/pack-release.mjs`); `npm pack --dry-run` against the workspace directory would pack the source-first manifest that never publishes. `pack-release.mjs` runs `pnpm pack --json --config.ignore-scripts=true` per package, which produces the exact tarballs a publish would ship, and packing without publishing is the dry run. Publishing remains a manual maintainer action (PLAN.md "Release artifacts").

## Environment

| Item | Value |
| --- | --- |
| Checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout` at `9c464343f0cfada6aa36f0a08144ed7cf1f0ce14` (`v1/rc0-migration`) |
| Node | v24.18.0 |
| pnpm (corepack, `packageManager: pnpm@11.21.0`) | 11.21.0 |
| Bun | 1.4.0 (not used by this gate) |
| Host | macOS 26.2 arm64 |
| Date | 2026-08-30 |

## Commands

| Command | Exit | Final output |
| --- | --- | --- |
| `node scripts/pack-release.mjs --names` | 0 | 40 names in publication order; the script's built-in roster check against rc-contract.md section 3.1 passed (it throws on any mismatch) |
| `corepack pnpm -r --no-bail --if-present run build` | 0 | every package `build: Done` (dist/esm and dist/cjs emitted; the `import.meta` line under `packages/cli build` is an esbuild CJS-target warning, not an error). Log: `/private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/npm-pack-build.log` |
| `node scripts/pack-release.mjs <scratch>/release-packs` | 0 on attempt 3 | silent success; 40 tarballs plus `manifest.json` written |

Pack attempts 1 and 2 exited 1 in `assertBuilt` with `ENOENT ... packages/kernel/dist/esm/CapabilitySet.js`. The file existed before and after the run; concurrent Phase 7 gate lanes were running `pnpm -r run check` (`tsc -b tsconfig.json` re-emits into `dist/`) and package builds in the same shared clean checkout, and the pack raced a `dist` rewrite. This is a shared-checkout scheduling artifact, not a repository defect: attempt 3 ran the same command unchanged and passed, `assertBuilt` verified every `src/**/*.ts` had its `dist/esm/*.js`, `dist/esm/*.d.ts`, and `dist/cjs/*.js` at pack time, and the tarball-completeness check below re-proves it on the final artifacts. `pack-release.mjs` deletes stale `.tgz` and `manifest.json` before each run, so the verified directory is wholly the output of the successful attempt. `git status --porcelain` in the clean checkout is empty after packing.

## Roster

`manifest.json` lists exactly 40 tarballs, matching rc-contract.md section 3.1 (39 `@smthrs/*` names plus the unscoped `smthrs` deprecation notice). `readWorkspaceManifests()` enforces this roster at pack time: it throws when the set of non-private `{engine, agent}` manifests differs from `publishedPackages`, so exit 0 is itself the roster proof. The output directory holds 41 files: 40 `.tgz` plus `manifest.json`, nothing else.

## Per-tarball verification

Every tarball was opened and its full entry list checked programmatically (script inline in the session; machine-readable results at `/private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/tarball-summary.json`).

Checks that passed for all 40 tarballs:

- Sources: at least one `package/src/**/*.ts`, and for every shipped source module the matching `package/dist/esm/<module>.js`, `package/dist/esm/<module>.d.ts`, and `package/dist/cjs/<module>.js` are present (the same invariant `assertBuilt` enforces, re-proven on the final artifact).
- `package/package.json`, `package/LICENSE`, `package/README.md` present in all 40.
- Inner manifest: `version` is `1.0.0-rc.0`, `exports["."]` points at `./dist/esm/...` (rewritten from `publishConfig.exports`; the `smthrs` notice exports `.` only, per contract section 3.3), `publishConfig.exports` removed after promotion, `publishConfig.tag` is `rc` (ruling R-40), no `private` flag, and no `workspace:` range in `dependencies` or `peerDependencies`. A workspace-wide manifest scan also found zero `@smthrs/*` sibling ranges other than exact `1.0.0-rc.0`.
- Migrations: `@smthrs/journal`, `@smthrs/run-store`, `@smthrs/plan`, `@smthrs/engine-store`, `@smthrs/step-cache` ship `package/src/migrations/*.ts` and the compiled `package/dist/esm/migrations/*` (plus cjs). `@smthrs/memory` ships its migration statements compiled into `dist/*/internal/Sql.js` (`migrate` runs embedded `CREATE TABLE IF NOT EXISTS` statements in one write transaction); the `packages/memory/src/migrations/*.sql` files are documentation mirrors of those statements (`src/internal/Sql.ts:62`), are referenced by no code, and `packages/memory/src` contains no filesystem read, so their exclusion by the `files` glob (`src/**/*.ts`) breaks nothing at runtime.
- Assets: `@smthrs/jj` ships `package/wasm/flows_jj.wasm`; `@smthrs/cli` ships `package/bin/smithers.mjs` (the `smithers` bin) and its `docs/**`; `@smthrs/migrate` ships its `smithers-migrate` bin target `package/dist/esm/flow/bin.js`. `THIRD_PARTY_NOTICES.md` is present in `@smthrs/engine`, `@smthrs/flow`, `@smthrs/jj`, and `VENDOR.md` in `@smthrs/engine`, satisfying "where present" (contract section 3.1).
- Forbidden content: zero entries under `package/test/`, zero entries with a `legacy` path segment, zero entries with a `node_modules` path segment, zero `.tsbuildinfo`, `coverage`, `.smithers`, or `.env` entries. A structural sweep found zero entries outside `package/{src,dist,bin,docs,wasm}/` and the root files `package.json`, `LICENSE`, `README.md`, `CHANGELOG.md`, `THIRD_PARTY_NOTICES.md`, `VENDOR.md`.

Sanctioned `test` content, for the record: ten packages ship helper modules under `src/test/` and their `dist` builds (`control/TestControl`, `database/{TestDatabase,DurableObjectStorageFake}`, `engine-store/TestStores`, `gateway/TestSuperviseRuntime`, `journal/{TestJournal,Notifying}`, `kernel/{TestHost,TestGrantStore,HostContract}`, `memory/TestMemory`, `run-store/TestRunStore`, `step-cache/TestCacheStore`, `sync/{TestSync,TestSocket}`). These live under `src/`, are exported through the `./*` wildcard, and rc-contract.md section 3.1 names them part of the public surface ("Published test helpers stay part of the public surface"). They are not vitest spec directories; every package's own `test/` spec directory is excluded from all 40 tarballs.

Also verified content-level: a byte scan of every `.js`, `.ts`, `.json`, `.md`, `.mjs` entry across all 40 tarballs for `smithers-orchestrator`, `smthrs/jsx-runtime`, and `jsxImportSource: smthrs` found hits only in `@smthrs/migrate` (detection tables and rewrite mappings such as `Detect.ts:30` `oldPackageNames = ["smthrs", "smithers-orchestrator"]`; the tool must name the 0.x packages to migrate them; no import statement references them) and in the `smthrs` deprecation README's removed-API table, which the contract requires (section 3.3). No other tarball contains any of the strings.

## Tarballs

Aggregate SHA-256 of the sorted `shasum -a 256` lines of all 40 tarballs: `83a0b02c18754e9a5ef43c8ce3332de9278719da131c7cca30023c6c5caa64b2`. Directory: `/private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/release-packs` (scratch; reproduce with the commands above).

| Package | Tarball | Entries | Bytes |
| --- | --- | --- | --- |
| `@smthrs/agent` | `smthrs-agent-1.0.0-rc.0.tgz` | 145 | 465,196 |
| `@smthrs/artifacts` | `smthrs-artifacts-1.0.0-rc.0.tgz` | 54 | 102,759 |
| `@smthrs/canonical` | `smthrs-canonical-1.0.0-rc.0.tgz` | 25 | 9,724 |
| `@smthrs/capability` | `smthrs-capability-1.0.0-rc.0.tgz` | 26 | 29,676 |
| `@smthrs/cli` | `smthrs-cli-1.0.0-rc.0.tgz` | 206 | 699,523 |
| `@smthrs/control` | `smthrs-control-1.0.0-rc.0.tgz` | 180 | 321,255 |
| `@smthrs/core` | `smthrs-core-1.0.0-rc.0.tgz` | 96 | 124,738 |
| `@smthrs/crypto` | `smthrs-crypto-1.0.0-rc.0.tgz` | 19 | 5,923 |
| `@smthrs/database` | `smthrs-database-1.0.0-rc.0.tgz` | 82 | 87,950 |
| `@smthrs/engine` | `smthrs-engine-1.0.0-rc.0.tgz` | 91 | 118,776 |
| `@smthrs/engine-store` | `smthrs-engine-store-1.0.0-rc.0.tgz` | 285 | 923,470 |
| `@smthrs/flow` | `smthrs-flow-1.0.0-rc.0.tgz` | 335 | 403,190 |
| `@smthrs/flows` | `smthrs-flows-1.0.0-rc.0.tgz` | 26 | 45,321 |
| `@smthrs/gateway` | `smthrs-gateway-1.0.0-rc.0.tgz` | 82 | 94,884 |
| `@smthrs/harness` | `smthrs-harness-1.0.0-rc.0.tgz` | 222 | 759,969 |
| `@smthrs/jj` | `smthrs-jj-1.0.0-rc.0.tgz` | 63 | 1,459,918 |
| `@smthrs/journal` | `smthrs-journal-1.0.0-rc.0.tgz` | 96 | 150,862 |
| `@smthrs/kernel` | `smthrs-kernel-1.0.0-rc.0.tgz` | 138 | 192,436 |
| `@smthrs/keys` | `smthrs-keys-1.0.0-rc.0.tgz` | 20 | 6,237 |
| `@smthrs/mcp` | `smthrs-mcp-1.0.0-rc.0.tgz` | 47 | 31,051 |
| `@smthrs/memory` | `smthrs-memory-1.0.0-rc.0.tgz` | 117 | 151,500 |
| `@smthrs/migrate` | `smthrs-migrate-1.0.0-rc.0.tgz` | 222 | 796,432 |
| `@smthrs/model` | `smthrs-model-1.0.0-rc.0.tgz` | 138 | 243,119 |
| `@smthrs/notifications` | `smthrs-notifications-1.0.0-rc.0.tgz` | 60 | 67,390 |
| `@smthrs/observability` | `smthrs-observability-1.0.0-rc.0.tgz` | 67 | 28,119 |
| `@smthrs/patterns` | `smthrs-patterns-1.0.0-rc.0.tgz` | 215 | 254,684 |
| `@smthrs/plan` | `smthrs-plan-1.0.0-rc.0.tgz` | 103 | 189,349 |
| `@smthrs/platform-browser` | `smthrs-platform-browser-1.0.0-rc.0.tgz` | 124 | 47,688 |
| `@smthrs/platform-bun` | `smthrs-platform-bun-1.0.0-rc.0.tgz` | 26 | 9,778 |
| `@smthrs/platform-node` | `smthrs-platform-node-1.0.0-rc.0.tgz` | 40 | 111,552 |
| `@smthrs/plugin` | `smthrs-plugin-1.0.0-rc.0.tgz` | 61 | 38,601 |
| `@smthrs/registry` | `smthrs-registry-1.0.0-rc.0.tgz` | 96 | 187,407 |
| `@smthrs/run-store` | `smthrs-run-store-1.0.0-rc.0.tgz` | 75 | 128,667 |
| `@smthrs/sandbox` | `smthrs-sandbox-1.0.0-rc.0.tgz` | 250 | 75,641 |
| `@smthrs/std` | `smthrs-std-1.0.0-rc.0.tgz` | 313 | 397,341 |
| `@smthrs/step-cache` | `smthrs-step-cache-1.0.0-rc.0.tgz` | 61 | 58,910 |
| `@smthrs/sync` | `smthrs-sync-1.0.0-rc.0.tgz` | 152 | 170,819 |
| `@smthrs/testing` | `smthrs-testing-1.0.0-rc.0.tgz` | 194 | 286,496 |
| `@smthrs/time-travel` | `smthrs-time-travel-1.0.0-rc.0.tgz` | 131 | 231,839 |
| `smthrs` | `smthrs-1.0.0-rc.0.tgz` | 11 | 4,219 |

The `smthrs` deprecation tarball contains exactly `src/index.ts`, its esm/cjs build, `LICENSE`, `README.md`, `CHANGELOG.md`, and `package.json` with `exports` limited to `.`, no `bin`, and `smthrs.group: "agent"`, as contract section 3.3 requires.

## Verdict

PASS. `pack-release.mjs` packed all 40 public packages at `1.0.0-rc.0` in dependency order with exit 0 from the clean checkout at `9c464343f0`. Every tarball ships its sources with complete esm/cjs/d.ts builds, its migrations (compiled, plus `src/migrations` sources where they exist as TypeScript), its assets (jj wasm, CLI bin shim, migrate bin), LICENSE, and README, and no tarball contains anything from a `test/` spec directory, `legacy/`, or `node_modules`.
