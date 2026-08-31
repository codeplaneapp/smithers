# Phase 7 gate: npm-pack

This run supersedes the npm-pack run at `cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba` (2026-08-31, earlier the same day). It re-validates the gate at `341c8fa87e2dadbe80d0f0d3258dae112a7d03d3` after the wave 7 and wave 8 commits; the earlier run's method and observations that still apply are carried forward below, updated to the new commit.

Verdict: **PASS**. All 40 public packages named in `rc-contract.md` section 3.1 pack through `scripts/pack-release.mjs`; every tarball carries sources, built ESM and CJS output with declarations, migrations, assets, LICENSE, and README; no tarball carries anything from a root `test/` directory, `legacy/`, or `node_modules/`. The two wave 8 packaging fixes are confirmed: `smthrs-1.0.0-rc.0.tgz` now packs `dist/cjs/package.json` (`{"type":"commonjs"}`), and `smthrs-memory-1.0.0-rc.0.tgz` now packs `src/migrations/{0001_memory,0002_memory_fts,0003_memory_vectors}.sql`, byte-equal to the source files. Only the five tarballs whose inputs changed since `cd14388ed7` differ; the other 35 are byte-identical to the superseded run.

Date: 2026-08-31. Commit: `341c8fa87e2dadbe80d0f0d3258dae112a7d03d3` (`v1/rc0-migration`). Evidence directory: `/private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/npm-pack/` (build3.log, pack-r2.log, inspect-r2.json, inspect-r2.out, sha256-341c-run{1,2}.txt, probe fixtures; the packed tarball directories were deleted after hashing because the host has about 12 GiB free).

## Environment

| Tool | Version |
| --- | --- |
| macOS | Darwin 25.2.0, arm64 |
| node | v24.18.0 (smthrs load probe repeated under v22.19.0, the `engines` floor) |
| pnpm | 11.21.0 (`corepack pnpm`) |
| npm | 11.16.0 (dry-run cross-check inside the inspection) |
| bun | 1.4.0 (not used by this gate) |

Machine load: 3.4 (1-minute average) when the gate started, 17.5 during the inspection while other agents worked; both under the serial-steps threshold of 40.

## Where the gate ran

The superseded run had found concurrent gates rewriting `packages/*/dist` inside the shared clean checkout `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4` (its observation 1), so it packed from a private shared clone. This run reused that clone, moved to the new commit:

```
$ cd <scratch>/npm-pack/checkout           # git clone --shared of clean-checkout-4
$ git fetch origin && git checkout --detach 341c8fa87e2dadbe80d0f0d3258dae112a7d03d3
$ git status --short | wc -l               # 0
$ corepack pnpm install --frozen-lockfile --offline --ignore-scripts   # "Already up to date", 64 workspace projects, exit 0
```

No concurrent process touched this clone; `git status --short` printed nothing after the build and both packs. The `vendor/jj` submodule is not needed to pack: `packages/jj/wasm/flows_jj.wasm` is tracked.

## What changed since the superseded run

`git log cd14388ed7..341c8fa87e` holds 15 commits. The packaging-relevant deltas:

- `packages/smthrs-deprecation/package.json` `files` gains `dist/**/package.json`, so the `{"type":"commonjs"}` marker that `scripts/build.mjs` writes now packs (fixes the superseded run's observation 2).
- `packages/memory/package.json` `files` gains `src/**/*.sql`, so the three reference migration copies that `src/internal/Sql.ts` cites now pack (fixes the superseded run's observation 3).
- `scripts/pack-release.test.mjs` gains four tests: every published manifest packs the module-type marker its build writes, a `packsPath` glob-semantics unit test, `@smthrs/memory` packs the SQL reference copies its shipped source cites, and the install docs pin `@effect/platform-node-shared` through `overrides` at `4.0.0-rc.108`.
- Source changes in `packages/{agent,cli,control}` (wave 7 cli-refuse-before-boot, wave 8 init-scaffold-launch) and `packages/cli/docs/llms-full.txt` (docs-served-llms), which land inside the `@smthrs/{agent,cli,control}` tarballs.

## Commands and results

| Step | Command (cwd = private clone) | Window (UTC) | Exit | Final output |
| --- | --- | ---: | ---: | --- |
| 0 | `git checkout --detach 341c8fa87e` + `corepack pnpm install --frozen-lockfile --offline --ignore-scripts` | 16:17 | 0 | `Already up to date`, 64 workspace projects |
| 1 | `node --test scripts/pack-release.test.mjs` | 16:17 | 0 | `tests 16`, `pass 16`, `fail 0` (12 at the superseded run; the four new tests pin this gate's two headline fixes) |
| 2 | `corepack pnpm -r --no-bail --if-present --filter=<each of the 40 names> run build` | 16:17:38 to 16:18:28 | 0 | 40 lines `build: Done`, zero `error`/`failed` lines |
| 3 | `node scripts/pack-release.mjs <scratch>/npm-pack/release-packs` | 16:18:33 to 16:19:07 | 0 | 40 `.tgz` + `manifest.json` (40 entries, all `1.0.0-rc.0`), 9.2 MB total |
| 4 | `node <scratch>/npm-pack/inspect.mjs <clone> <packs> inspect-r2.json` | 16:19:41 to 16:23:04 | 0 | `packages=40 violations=0` |
| 5 | `node scripts/pack-release.mjs <scratch>/npm-pack/release-packs-2`, then `shasum -a 256` on both runs | 16:23 | 0 | 40/40 tarballs byte-identical across the two pack runs; `manifest.json` identical |
| 6 | `git status --short \| wc -l` after build and both packs | 16:24 | 0 | `0` |

The build filter list is `node scripts/pack-release.mjs --names`, which prints the 40 names in publication order (`canonical, capability, crypto, artifacts, core, database, jj, journal, keys, migrate, notifications, observability, patterns, plan, flow, engine, plugin, run-store, smthrs, step-cache, sync, kernel, engine-store, model, memory, platform-browser, platform-node, platform-bun, registry, control, gateway, harness, mcp, sandbox, std, agent, testing, time-travel, flows, cli`). `pack-release.mjs` refuses to run unless the non-private `{engine, agent}` manifests equal exactly those 40 names, and it asserts `dist/esm/*.js`, `dist/esm/*.d.ts`, and `dist/cjs/*.js` for every `src/**/*.ts` before packing.

## What the inspection checks

`inspect.mjs` (kept beside the logs) runs these checks on every tarball and fails on any violation. Checks 1 to 7 are unchanged from the superseded run; this run hardened two former notes into violations (marked new):

1. `package.json`, `LICENSE`, `README.md` present.
2. At least one `src/**/*.ts`, `dist/esm/*.js`, `dist/esm/*.d.ts`, `dist/cjs/*.js`; and for every `src/**/*.ts` in the tarball, its `dist/esm/<m>.js`, `dist/esm/<m>.d.ts`, and `dist/cjs/<m>.js` are also in the tarball.
3. No entry matches `package/test/`, `node_modules/`, `legacy/`, `*.tsbuildinfo`, `coverage/`, `.smithers/`, `*.test.*`, `vitest.config.*`, `tsconfig*.json`, `BUILD.ts`, `scripts/build.mjs`, `.env*`, `.git*`.
4. The packed `package.json` has `version` `1.0.0-rc.0`, no `private`, `publishConfig.tag` `rc`, no `publishConfig.exports`, and `exports` byte-equal to the source manifest's `publishConfig.exports`; no `workspace:` range survives in any dependency field; `effect` is pinned `4.0.0-rc.108` outside `devDependencies`.
5. Every literal (non-wildcard) `exports` target and every `bin` target exists in the tarball.
6. Package-specific requirements: migrations (`journal`, `engine-store`, `run-store`, `step-cache`, `plan`) present in `src/migrations`, `dist/esm/migrations`, and `dist/cjs/migrations` with equal counts; `jj` ships `wasm/flows_jj.wasm` and `THIRD_PARTY_NOTICES.md`; `cli` ships `bin/smithers.mjs`, `bin/dangling-workspace-links.mjs` (imported by the shim), `docs/llms.txt`, `docs/llms-full.txt`, `docs/SKILL.md`, `dist/esm/bin.js`; `migrate` ships its `bin` target `dist/esm/flow/bin.js`; `engine` ships `THIRD_PARTY_NOTICES.md` and `VENDOR.md`; `flow` ships `THIRD_PARTY_NOTICES.md`.
7. Cross-check: `npm pack --dry-run --json --ignore-scripts` in each workspace directory yields the same file set as the pnpm tarball (40/40 identical, zero `npm dry-run differs` notes).
8. New this run: a missing `dist/cjs/package.json` is a violation for every tarball, not a note. All 40 carry it.
9. New this run: `@smthrs/memory` must pack all three `src/migrations/*.sql` reference copies. It packs 3/3.

Raw confirmations from `tar` on the packed tarballs:

- `smthrs-1.0.0-rc.0.tgz` (12 entries, was 11): `package/dist/cjs/package.json` present; `tar -xzO` prints `{"type":"commonjs"}`.
- `smthrs-memory-1.0.0-rc.0.tgz` (120 entries, was 117): `package/src/migrations/{0001_memory,0002_memory_fts,0003_memory_vectors}.sql` present and byte-equal to `packages/memory/src/migrations/*.sql` at the validated commit (`diff` per file).
- `smthrs-jj-1.0.0-rc.0.tgz`: `package/wasm/flows_jj.wasm` is 4,740,823 bytes, the size `rc-contract.md` section 9 records.
- `smthrs-cli-1.0.0-rc.0.tgz`: `bin/smithers.mjs`, `bin/dangling-workspace-links.mjs`, `docs/SKILL.md`, `docs/llms.txt`, `docs/llms-full.txt`, `dist/esm/bin.js`.
- `smthrs-engine-1.0.0-rc.0.tgz`: `THIRD_PARTY_NOTICES.md`, `VENDOR.md`.
- `smthrs-journal-1.0.0-rc.0.tgz`: 14 migration entries across `src/migrations` and both `dist` trees.
- Across all 40 tarballs (4,705 entries; 4,701 at the superseded run, the difference being the four new files above): zero entries match `^package/test/`, `legacy/`, `node_modules/`, `\.tsbuildinfo$`, or `coverage/`.

## Load probes on the packed artifacts

`smthrs` extracted from this run's tarball into the probe project's `node_modules/smthrs`: `require("smthrs")` and `import("smthrs")` both throw `smthrs 1.0 is a migration notice, not a runtime.` under Node v24.18.0 and v22.19.0 (`rc-contract.md` section 3.3). The superseded run proved the same behavior without the marker; this run proves the marker's presence changes nothing observable and the notice still throws in both module systems. The canonical/flows dist-load probes and the bare-extraction dependency-resolution shape from the superseded run were not repeated: no commit since `cd14388ed7` touched those packages' sources, and their tarballs are byte-identical to the ones probed there.

## Tarballs changed since the superseded run

Exactly the five tarballs whose inputs changed differ from the `cd14388ed7` hashes; the other 35 are byte-identical:

| Tarball | Why it changed |
| --- | --- |
| `smthrs-1.0.0-rc.0.tgz` | packs `dist/cjs/package.json` |
| `smthrs-memory-1.0.0-rc.0.tgz` | packs the three `.sql` reference copies |
| `smthrs-agent-1.0.0-rc.0.tgz` | wave 8 `AgentSession` settle-failed fix |
| `smthrs-control-1.0.0-rc.0.tgz` | wave 8 `ControlLive` settle-failed fix |
| `smthrs-cli-1.0.0-rc.0.tgz` | wave 7 refuse-before-boot, wave 8 init scaffold, refreshed `docs/llms-full.txt` and README |

## Observations (none blocks the gate)

1. **Concurrent dist writers in the shared clean checkout** (carried from the superseded run). Any pack run inside `clean-checkout-4` is nondeterministic while other gates run `tsc -b` or `rmSync(dist)` builds there. No concurrent writer was active this time, but the gate still packed from the private clone; keep doing that.
2. **Resolved: `smthrs` lacked `dist/cjs/package.json`** (superseded run observation 2). Fixed by `a42f8f6e5d` (polish-2); now a hard inspection requirement and pinned by `scripts/pack-release.test.mjs` ("every published manifest packs the module-type marker its build writes").
3. **Resolved: `@smthrs/memory` shipped no `.sql` files** (superseded run observation 3). Fixed by the same commit; now a hard inspection requirement and pinned by `scripts/pack-release.test.mjs` ("@smthrs/memory packs the SQL reference copies its shipped source cites").
4. **`src/test/` helpers ship in 10 packages (15 files)** through the `./*` wildcard, which `rc-contract.md` section 3.1 declares public: `control/TestControl`, `database/{DurableObjectStorageFake,TestDatabase}`, `engine-store/TestStores`, `gateway/TestSuperviseRuntime`, `journal/{Notifying,TestJournal}`, `kernel/{HostContract,TestGrantStore,TestHost}`, `memory/TestMemory`, `run-store/TestRunStore`, `step-cache/TestCacheStore`, `sync/{TestSocket,TestSync}`. The contract's named list omits `TestControl`, `TestMemory`, `DurableObjectStorageFake`, and `HostContract`; under the contract's own rule ("the wildcard surface is the contract") they are public API. Documentation drift, not a packaging defect. No root `test/` directory (the vitest suites) is packed.
5. **`devDependencies` remain in the packed manifests** (14 to 22 entries per package). pnpm and npm both keep the field when packing and ignore it on install. No action.

## Per-tarball inventory (pack run 1, byte-identical to run 2)

Columns: bytes, entries in the tarball, `src/**/*.ts` count, `dist/esm/*.js`, `dist/esm/*.d.ts`, `dist/cjs/*.js`.

| Package | Tarball | Bytes | Files | src .ts | esm .js | esm .d.ts | cjs .js | Problems | Notes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `@smthrs/canonical` | `smthrs-canonical-1.0.0-rc.0.tgz` | 9724 | 25 | 3 | 3 | 3 | 3 | none | devDependencies kept (15) |
| `@smthrs/capability` | `smthrs-capability-1.0.0-rc.0.tgz` | 29676 | 26 | 3 | 3 | 3 | 3 | none | devDependencies kept (16) |
| `@smthrs/crypto` | `smthrs-crypto-1.0.0-rc.0.tgz` | 5923 | 19 | 2 | 2 | 2 | 2 | none | devDependencies kept (17) |
| `@smthrs/artifacts` | `smthrs-artifacts-1.0.0-rc.0.tgz` | 102759 | 54 | 7 | 7 | 7 | 7 | none | devDependencies kept (17) |
| `@smthrs/core` | `smthrs-core-1.0.0-rc.0.tgz` | 124738 | 96 | 13 | 13 | 13 | 13 | none | devDependencies kept (17) |
| `@smthrs/database` | `smthrs-database-1.0.0-rc.0.tgz` | 87950 | 82 | 11 | 11 | 11 | 11 | none | devDependencies kept (16); src/test helpers 2 (public via ./*) |
| `@smthrs/jj` | `smthrs-jj-1.0.0-rc.0.tgz` | 1459918 | 63 | 8 | 8 | 8 | 8 | none | devDependencies kept (16); wasm bytes 4740823 |
| `@smthrs/journal` | `smthrs-journal-1.0.0-rc.0.tgz` | 150862 | 96 | 13 | 13 | 13 | 13 | none | devDependencies kept (16); migrations src/esm/cjs 2/2/2; src/test helpers 2 (public via ./*) |
| `@smthrs/keys` | `smthrs-keys-1.0.0-rc.0.tgz` | 6237 | 20 | 2 | 2 | 2 | 2 | none | devDependencies kept (17) |
| `@smthrs/migrate` | `smthrs-migrate-1.0.0-rc.0.tgz` | 796432 | 222 | 31 | 31 | 31 | 31 | none | devDependencies kept (15) |
| `@smthrs/notifications` | `smthrs-notifications-1.0.0-rc.0.tgz` | 67390 | 60 | 8 | 8 | 8 | 8 | none | devDependencies kept (17) |
| `@smthrs/observability` | `smthrs-observability-1.0.0-rc.0.tgz` | 28119 | 67 | 9 | 9 | 9 | 9 | none | devDependencies kept (16) |
| `@smthrs/patterns` | `smthrs-patterns-1.0.0-rc.0.tgz` | 254684 | 215 | 30 | 30 | 30 | 30 | none | devDependencies kept (17) |
| `@smthrs/plan` | `smthrs-plan-1.0.0-rc.0.tgz` | 189349 | 103 | 14 | 14 | 14 | 14 | none | devDependencies kept (17); migrations src/esm/cjs 1/1/1 |
| `@smthrs/flow` | `smthrs-flow-1.0.0-rc.0.tgz` | 403190 | 335 | 47 | 47 | 47 | 47 | none | devDependencies kept (17) |
| `@smthrs/engine` | `smthrs-engine-1.0.0-rc.0.tgz` | 118776 | 91 | 12 | 12 | 12 | 12 | none | devDependencies kept (19) |
| `@smthrs/plugin` | `smthrs-plugin-1.0.0-rc.0.tgz` | 38601 | 61 | 8 | 8 | 8 | 8 | none | devDependencies kept (16) |
| `@smthrs/run-store` | `smthrs-run-store-1.0.0-rc.0.tgz` | 128667 | 75 | 10 | 10 | 10 | 10 | none | devDependencies kept (16); migrations src/esm/cjs 2/2/2; src/test helpers 1 (public via ./*) |
| `smthrs` | `smthrs-1.0.0-rc.0.tgz` | 4270 | 12 | 1 | 1 | 1 | 1 | none | devDependencies kept (14) |
| `@smthrs/step-cache` | `smthrs-step-cache-1.0.0-rc.0.tgz` | 58910 | 61 | 8 | 8 | 8 | 8 | none | devDependencies kept (16); migrations src/esm/cjs 1/1/1; src/test helpers 1 (public via ./*) |
| `@smthrs/sync` | `smthrs-sync-1.0.0-rc.0.tgz` | 170819 | 152 | 21 | 21 | 21 | 21 | none | devDependencies kept (16); src/test helpers 2 (public via ./*) |
| `@smthrs/kernel` | `smthrs-kernel-1.0.0-rc.0.tgz` | 192436 | 138 | 19 | 19 | 19 | 19 | none | devDependencies kept (16); src/test helpers 3 (public via ./*) |
| `@smthrs/engine-store` | `smthrs-engine-store-1.0.0-rc.0.tgz` | 942122 | 292 | 41 | 41 | 41 | 41 | none | devDependencies kept (21); migrations src/esm/cjs 2/2/2; src/test helpers 1 (public via ./*) |
| `@smthrs/model` | `smthrs-model-1.0.0-rc.0.tgz` | 243119 | 138 | 19 | 19 | 19 | 19 | none | devDependencies kept (16) |
| `@smthrs/memory` | `smthrs-memory-1.0.0-rc.0.tgz` | 152459 | 120 | 16 | 16 | 16 | 16 | none | devDependencies kept (16); reference .sql files packed: 3/3; src/test helpers 1 (public via ./*) |
| `@smthrs/platform-browser` | `smthrs-platform-browser-1.0.0-rc.0.tgz` | 47688 | 124 | 17 | 17 | 17 | 17 | none | devDependencies kept (16) |
| `@smthrs/platform-node` | `smthrs-platform-node-1.0.0-rc.0.tgz` | 111552 | 40 | 5 | 5 | 5 | 5 | none | devDependencies kept (17) |
| `@smthrs/platform-bun` | `smthrs-platform-bun-1.0.0-rc.0.tgz` | 9778 | 26 | 3 | 3 | 3 | 3 | none | devDependencies kept (17) |
| `@smthrs/registry` | `smthrs-registry-1.0.0-rc.0.tgz` | 187407 | 96 | 13 | 13 | 13 | 13 | none | devDependencies kept (21) |
| `@smthrs/control` | `smthrs-control-1.0.0-rc.0.tgz` | 336217 | 180 | 25 | 25 | 25 | 25 | none | devDependencies kept (21); src/test helpers 1 (public via ./*) |
| `@smthrs/gateway` | `smthrs-gateway-1.0.0-rc.0.tgz` | 99391 | 82 | 11 | 11 | 11 | 11 | none | devDependencies kept (22); src/test helpers 1 (public via ./*) |
| `@smthrs/harness` | `smthrs-harness-1.0.0-rc.0.tgz` | 759969 | 222 | 31 | 31 | 31 | 31 | none | devDependencies kept (18) |
| `@smthrs/mcp` | `smthrs-mcp-1.0.0-rc.0.tgz` | 31051 | 47 | 6 | 6 | 6 | 6 | none | devDependencies kept (18) |
| `@smthrs/sandbox` | `smthrs-sandbox-1.0.0-rc.0.tgz` | 75641 | 250 | 35 | 35 | 35 | 35 | none | devDependencies kept (16) |
| `@smthrs/std` | `smthrs-std-1.0.0-rc.0.tgz` | 397341 | 313 | 44 | 44 | 44 | 44 | none | devDependencies kept (17) |
| `@smthrs/agent` | `smthrs-agent-1.0.0-rc.0.tgz` | 480457 | 145 | 20 | 20 | 20 | 20 | none | devDependencies kept (18) |
| `@smthrs/testing` | `smthrs-testing-1.0.0-rc.0.tgz` | 286517 | 194 | 27 | 27 | 27 | 27 | none | devDependencies kept (17) |
| `@smthrs/time-travel` | `smthrs-time-travel-1.0.0-rc.0.tgz` | 231839 | 131 | 18 | 18 | 18 | 18 | none | devDependencies kept (22) |
| `@smthrs/flows` | `smthrs-flows-1.0.0-rc.0.tgz` | 45321 | 26 | 3 | 3 | 3 | 3 | none | devDependencies kept (16) |
| `@smthrs/cli` | `smthrs-cli-1.0.0-rc.0.tgz` | 717510 | 206 | 28 | 28 | 28 | 28 | none | devDependencies kept (16) |

packages=40 violations=0

## SHA-256 of the packed tarballs (byte-identical across two pack runs)

```
617e194a6682d507157c5882b045e09a1389a2d7e819eb9ba19c2feddcc58f92  smthrs-1.0.0-rc.0.tgz
a69736ba955c94294249419afd1284a289bd6fe037b6c7ab2e7384d6291b8ccc  smthrs-agent-1.0.0-rc.0.tgz
063bac3188d7f595e3908a2e8ce28ed19c79c35356c59cae757e6623c52d9992  smthrs-artifacts-1.0.0-rc.0.tgz
7aab09d2fbe2965d2feda42cc90f131fc6babc6640c3213c4d720536e83f0b22  smthrs-canonical-1.0.0-rc.0.tgz
99552175a8db3edb7797984c6de8e34c3bb69bb00aa08ff1360a1c8e10563096  smthrs-capability-1.0.0-rc.0.tgz
6c6c03d082002de50ef20732da1260652ec3390075180182b8ae9a5ea9617f9b  smthrs-cli-1.0.0-rc.0.tgz
a2888b0a86bd72f6b69151af09d8108df3c56d8d551b31254c86ab08c14c771b  smthrs-control-1.0.0-rc.0.tgz
a65e151e1c3171f229acb8dead5dd29c4ba1251ceec40b17a5d63dc5e507352a  smthrs-core-1.0.0-rc.0.tgz
914a4c3647df15823db8e20d29fed5852d0a3d5b6296bbf9e1627ff3c9ba9d67  smthrs-crypto-1.0.0-rc.0.tgz
ac092980751f23d90aa93561f23f6edf4f90ff873cd15b80156664e11b7d6c5b  smthrs-database-1.0.0-rc.0.tgz
2c8b0d1c9950eea1e650b6c61d5b7ffc8c6eee3f79c875bf6227a42cbc926dfe  smthrs-engine-1.0.0-rc.0.tgz
fdd68279e8be46fc27e59ffbfd613577cbe723bdcc155476228d27aa714a24b0  smthrs-engine-store-1.0.0-rc.0.tgz
39e0508ab17bc0ddd82ad2d75a94a32b97e48b28be6f0af884e91533955562c2  smthrs-flow-1.0.0-rc.0.tgz
a30220e65365da8783fb420470aa2975ea762009bbf4d30b9ce3deb465d1de61  smthrs-flows-1.0.0-rc.0.tgz
8cf502dc44339c9730394069c4fdda98d1ee1075ba7402ebffc2d939bdfcce9e  smthrs-gateway-1.0.0-rc.0.tgz
5b1e35ae5855f5cd36284d03d202a338bbf4df6ba3b76ea3df51f4cb1b668ac2  smthrs-harness-1.0.0-rc.0.tgz
e2b28535df6f3627f3385cd41df04dbb424099b5615c0fd2498c2b5c95300509  smthrs-jj-1.0.0-rc.0.tgz
7ab68d68563eca0097b0b17bfd01310cca0ce3bb30d418cc573d8c93b522ea48  smthrs-journal-1.0.0-rc.0.tgz
079fb520f999efed371174a64c040b005a2286b2f8b6e99fa917408584d56108  smthrs-kernel-1.0.0-rc.0.tgz
10febe59b296dc088281b33d8c7c31d8894c4c651afc69113cddbfc73d453141  smthrs-keys-1.0.0-rc.0.tgz
b959bb9810b5158c5194dc38a82722802769111e2381897062afc04729ce2782  smthrs-mcp-1.0.0-rc.0.tgz
a1e80f1c188f985e6a35e326fd4711a6e6515e6badea4bd24f5daa7a8c28a487  smthrs-memory-1.0.0-rc.0.tgz
e6c27a2c18dcd256aae870de17eb0bf7f62119f69caa4690586450ec9d2ae827  smthrs-migrate-1.0.0-rc.0.tgz
e11be68347e074a5a0ca8b2ba60b7fb0f926b7e8c18994c3835aa2f6bf68b227  smthrs-model-1.0.0-rc.0.tgz
4a8fbf56da2e19d27becae113914bded8ae91e7017ba28bbdbf7ea29de20710a  smthrs-notifications-1.0.0-rc.0.tgz
2f8ed25499cbd4375a67d28f7dbbc0ed16f357f7403ced083410b562293aa484  smthrs-observability-1.0.0-rc.0.tgz
1f1e199dcccaf01d9891cbc3e4c75774d2251a34d7ab897dcfe3e10c1f937f6c  smthrs-patterns-1.0.0-rc.0.tgz
3ffe6b6d84f1db2562fc68afa8cf62f616fb0ed1458c4b30e0d893ca7a5ce462  smthrs-plan-1.0.0-rc.0.tgz
c85dc24e43da3051352323e7308b3bdd05f218aa9092ebe2392ab7533e3182a5  smthrs-platform-browser-1.0.0-rc.0.tgz
0750f902057e251577bb5bbbd0479ac80d1cbe7d62d401230a0313eb2d5069ff  smthrs-platform-bun-1.0.0-rc.0.tgz
37b95190d0eefa6259d4cb7ac20913e5d681661eef7ab46429d329cdefb9c87d  smthrs-platform-node-1.0.0-rc.0.tgz
15f139af9e22563f36db0fb11580b3f2590f463ad77376d951f8994a7b147a3f  smthrs-plugin-1.0.0-rc.0.tgz
f721fe93daeed57922344d1c79470eae1fe5d6ada5e910f1b1d416b9d7a6305d  smthrs-registry-1.0.0-rc.0.tgz
5a3152f7a76c0ef1ac5eb60ccba01dc557dc5d7af05fd73a45c5147283cd357c  smthrs-run-store-1.0.0-rc.0.tgz
a6090b2689347cb05e66abec1cd25b189e570fe70926e707f1f384f750a2eac8  smthrs-sandbox-1.0.0-rc.0.tgz
27c4a13868b8b1dfb5fc7e93bd6b05775bb309bd19dccecbcccd5a84e4bdcde7  smthrs-std-1.0.0-rc.0.tgz
5e9751abfeed4e997fd75e4bb18c134a622f36d2d022fd9ba3bc837591203dde  smthrs-step-cache-1.0.0-rc.0.tgz
72a27e5afe35707a229b21d5a58a78152b510c5ee738e1cadddf7b680ff57237  smthrs-sync-1.0.0-rc.0.tgz
1ec08f907756017f540643728d4d2d32d4091ef52d22da0b567fffc4971526da  smthrs-testing-1.0.0-rc.0.tgz
982d25d8b1b03d6fcb90cb40bf2bba6731c545dd0f76e1bac7aeeba1a6025997  smthrs-time-travel-1.0.0-rc.0.tgz
```

## Reproduce

```
git clone --shared <clean-checkout> <dir> && git -C <dir> checkout --detach 341c8fa87e2dadbe80d0f0d3258dae112a7d03d3
cd <dir> && corepack pnpm install --frozen-lockfile --offline --ignore-scripts
node --test scripts/pack-release.test.mjs
corepack pnpm -r --no-bail --if-present $(node scripts/pack-release.mjs --names | sed "s/^/--filter=/") run build
node scripts/pack-release.mjs <packs>
node /private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/npm-pack/inspect.mjs <dir> <packs> inspect.json
```
