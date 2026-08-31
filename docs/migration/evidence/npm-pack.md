# Phase 7 gate: npm-pack

Verdict: **PASS**. All 40 public packages named in `rc-contract.md` section 3.1 pack through `scripts/pack-release.mjs`; every tarball carries sources, built ESM and CJS output with declarations, migrations, assets, LICENSE, and README; no tarball carries anything from a root `test/` directory, `legacy/`, or `node_modules/`.

Date: 2026-08-31. Commit: `cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba` (`v1/rc0-migration`). Evidence directory: `/private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/npm-pack/` (logs, tarballs, inspection JSON, probe fixtures).

## Environment

| Tool | Version |
| --- | --- |
| macOS | Darwin 25.2.0, arm64 |
| node | v24.18.0 (load probes repeated under v22.19.0, the `engines` floor) |
| pnpm | 11.21.0 (`corepack pnpm`) |
| npm | 11.16.0 (dry-run cross-check only) |
| bun | 1.4.0 (not used by this gate) |

## Where the gate ran

The shared clean checkout `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4` had other gates writing into `packages/*/dist` while this gate ran:

- pid 51715 `corepack pnpm -r --no-bail --if-present run check`, whose per-package `check` script is `tsc -b tsconfig.json`, which emits into `dist/esm` and writes `dist/tsconfig.tsbuildinfo`;
- pids 79287 and 79290 `corepack pnpm --dir packages/sandbox run build` (two drivers at once), whose `scripts/build.mjs` starts with `rmSync(dist)`;
- pid 37525 `corepack pnpm -r --no-bail --if-present run test`, pid 77482 `pnpm exec vocs build`, pid 78310 `node scripts/check-docs.mjs`.

The first pack attempt in that checkout produced 26 tarballs and then failed:

```
$ node scripts/pack-release.mjs <scratch>/release-packs        # 12:03:37Z to 12:04:05Z, exit 1
Error: ENOENT: no such file or directory, access '.../clean-checkout-4/packages/platform-node/dist/esm/AtomicFileSystem.js'
    at async assertBuilt (scripts/pack-release.mjs:240:5)
```

The file had been emitted by this gate's own build (exit 0, `packages/platform-node build: Done`) and existed again when inspected two minutes later, so a concurrent `rmSync(dist)` from another gate removed it mid-pack. A tarball packed under those conditions can silently miss files, so the gate moved to a private copy of the same commit:

```
$ git clone --quiet --shared clean-checkout-4 <scratch>/npm-pack/checkout
$ git -C checkout checkout --quiet --detach cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba
$ git -C checkout status --short | wc -l                        # 0
$ corepack pnpm install --frozen-lockfile --offline --ignore-scripts   # exit 0, "Done in 1m 20.6s using pnpm v11.21.0"
```

`--ignore-scripts` is the CI install flag (`rc-contract.md` section 9, package manager row). The `vendor/jj` submodule is not needed to pack: `packages/jj/wasm/flows_jj.wasm` is tracked.

## Commands and results

| Step | Command (cwd = private clone unless noted) | Window (UTC) | Exit | Final output |
| --- | --- | ---: | ---: | --- |
| 0 | `corepack pnpm install --frozen-lockfile --offline` (shared checkout) | 12:00 | 0 | `Already up to date`, 64 workspace projects |
| 0 | `node --test scripts/pack-release.test.mjs` (shared checkout; reads manifests only) | 12:03 | 0 | `tests 12`, `pass 12`, `fail 0` |
| 1 | `corepack pnpm -r --no-bail --if-present --filter=<each of the 40 names> run build` | 12:09:30 to 12:12:10 | 0 | 40 lines `build: Done`, no `error`/`failed` lines |
| 2 | `node scripts/pack-release.mjs <scratch>/npm-pack/release-packs` | 12:12:51 to 12:13:21 | 0 | 40 `.tgz` + `manifest.json` (40 entries, all `1.0.0-rc.0`), 9.2 MB total |
| 3 | `node <scratch>/npm-pack/inspect.mjs <clone> <packs> inspect.json` | 12:13:36 to 12:15:56 | 0 | `packages=40 violations=0` |
| 4 | `node scripts/pack-release.mjs <scratch>/npm-pack/release-packs-2`, then `shasum -a 256` and `tar -tzf` per tarball | 12:16 | 0 | 40/40 tarballs byte-identical to run 2; `manifest.json` identical |
| 5 | `git status --short \| wc -l` after build and pack | 12:13 | 0 | `0` (dist and tgz are gitignored; the pack destination is outside the tree) |

The build filter list is `node scripts/pack-release.mjs --names`, which prints the 40 names in publication order (`canonical, capability, crypto, artifacts, core, database, jj, journal, keys, migrate, notifications, observability, patterns, plan, flow, engine, plugin, run-store, smthrs, step-cache, sync, kernel, engine-store, model, memory, platform-browser, platform-node, platform-bun, registry, control, gateway, harness, mcp, sandbox, std, agent, testing, time-travel, flows, cli`). `pack-release.mjs` refuses to run unless the non-private `{engine, agent}` manifests equal exactly those 40 names, and it asserts `dist/esm/*.js`, `dist/esm/*.d.ts`, and `dist/cjs/*.js` for every `src/**/*.ts` before packing.

## What the inspection checks

`inspect.mjs` (kept beside the tarballs) runs these checks on every tarball and fails on any violation:

1. `package.json`, `LICENSE`, `README.md` present.
2. At least one `src/**/*.ts`, `dist/esm/*.js`, `dist/esm/*.d.ts`, `dist/cjs/*.js`; and for every `src/**/*.ts` in the tarball, its `dist/esm/<m>.js`, `dist/esm/<m>.d.ts`, and `dist/cjs/<m>.js` are also in the tarball.
3. No entry matches `package/test/`, `node_modules/`, `legacy/`, `*.tsbuildinfo`, `coverage/`, `.smithers/`, `*.test.*`, `vitest.config.*`, `tsconfig*.json`, `BUILD.ts`, `scripts/build.mjs`, `.env*`, `.git*`.
4. The packed `package.json` has `version` `1.0.0-rc.0`, no `private`, `publishConfig.tag` `rc`, no `publishConfig.exports`, and `exports` byte-equal to the source manifest's `publishConfig.exports`; no `workspace:` range survives in any dependency field; `effect` is pinned `4.0.0-rc.108` outside `devDependencies`.
5. Every literal (non-wildcard) `exports` target and every `bin` target exists in the tarball.
6. Package-specific requirements: migrations (`journal`, `engine-store`, `run-store`, `step-cache`, `plan`) present in `src/migrations`, `dist/esm/migrations`, and `dist/cjs/migrations` with equal counts; `jj` ships `wasm/flows_jj.wasm` and `THIRD_PARTY_NOTICES.md`; `cli` ships `bin/smithers.mjs`, `bin/dangling-workspace-links.mjs` (imported by the shim), `docs/llms.txt`, `docs/llms-full.txt`, `docs/SKILL.md`, `dist/esm/bin.js`; `migrate` ships its `bin` target `dist/esm/flow/bin.js`; `engine` ships `THIRD_PARTY_NOTICES.md` and `VENDOR.md`; `flow` ships `THIRD_PARTY_NOTICES.md`.
7. Cross-check: `npm pack --dry-run --json --ignore-scripts` in each workspace directory yields the same file set as the pnpm tarball (40/40 identical).

Raw confirmations from `tar -tzf` / `tar -tvzf`:

- `smthrs-jj-1.0.0-rc.0.tgz`: `package/wasm/flows_jj.wasm` is 4,740,823 bytes, the size `rc-contract.md` section 9 records.
- `smthrs-journal-1.0.0-rc.0.tgz`: `src/migrations/{0001_initial,0002_checkpoints}.ts`, `dist/esm/migrations/*.{js,d.ts}`, `dist/cjs/migrations/*.js`, `LICENSE`, `README.md`, `CHANGELOG.md`.
- `smthrs-cli-1.0.0-rc.0.tgz`: `bin/smithers.mjs`, `bin/dangling-workspace-links.mjs`, `docs/SKILL.md`, `docs/llms.txt`, `docs/llms-full.txt`, `dist/esm/bin.js`.
- `smthrs-migrate-1.0.0-rc.0.tgz`: `dist/esm/flow/bin.js`, `dist/esm/flow/bin.d.ts`, `dist/cjs/flow/bin.js`.
- `smthrs-engine-1.0.0-rc.0.tgz`: `THIRD_PARTY_NOTICES.md`, `VENDOR.md`.
- Across all 40 tarballs (4,701 entries): zero entries match `^package/test/`, `legacy/`, `node_modules/`, `\.tsbuildinfo$`, or `coverage/`.

## Load probes on the packed artifacts

- `@smthrs/canonical` and `@smthrs/flows` built output, loaded under Node v22.19.0 from the private clone where dependencies resolve: `require("./dist/cjs/index.js")` and `import("./dist/esm/index.js")` both succeed (canonical 1 export, flows 33 exports in each format). Loading a bare extracted tarball without installing its dependencies fails with `Cannot find module 'effect/Effect'`, which is the expected shape; installing tarballs into a consumer is the smoke/consumer-fixture gate, not this one.
- `smthrs` extracted into a probe project's `node_modules/smthrs`: `require("smthrs")` and `import("smthrs")` both throw `Error: smthrs 1.0 is a migration notice, not a runtime.` under Node v24.18.0 and v22.19.0 (`rc-contract.md` section 3.3).

## Observations (none blocks the gate)

1. **Concurrent dist writers in the shared clean checkout.** `pnpm -r run check` (`tsc -b`) and per-package `run build` (`rmSync(dist)`) from other gates make any pack run in `clean-checkout-4` nondeterministic; this gate's first attempt failed with the ENOENT above. The orchestrator should serialize the gates that write `dist/`, or give the pack, smoke, and consumer-fixture gates their own checkout as this gate did. Reproduction: run `pnpm --dir packages/platform-node run build` in one shell while `node scripts/pack-release.mjs <dir>` runs in another.
2. **`smthrs` is the only tarball without `dist/cjs/package.json`.** `packages/smthrs-deprecation/package.json` `files` omits the `dist/**/package.json` glob that the other 39 manifests carry, so the `{"type":"commonjs"}` marker that `scripts/build.mjs` writes is dropped. Both Node 22.19.0 and 24.18.0 still evaluate the `require` entry as CommonJS and throw the notice (probed above, with a minimal control in `<scratch>/npm-pack/cjs-probe/ctl`), so the effect is a manifest inconsistency rather than a behavior defect. Fix-lane candidate: add `"dist/**/package.json"` to that `files` array.
3. **`@smthrs/memory` ships no `.sql` files.** `src/migrations/{0001_memory,0002_memory_fts,0003_memory_vectors}.sql` are excluded by `files: ["src/**/*.ts", ...]`. `src/internal/Sql.ts:62` states the runtime `migrate` statements "mirror `src/migrations/*.sql`" and `MemoryStore.ts:680` applies `Sql.migrate`, so the SQL files are reference copies and the tarball migrates without them. Decide whether the reference files should ship; if yes, add `src/migrations/*.sql` to `files`.
4. **`src/test/` helpers ship in 10 packages (15 files)** through the `./*` wildcard, which `rc-contract.md` section 3.1 declares public: `control/TestControl`, `database/{DurableObjectStorageFake,TestDatabase}`, `engine-store/TestStores`, `gateway/TestSuperviseRuntime`, `journal/{Notifying,TestJournal}`, `kernel/{HostContract,TestGrantStore,TestHost}`, `memory/TestMemory`, `run-store/TestRunStore`, `step-cache/TestCacheStore`, `sync/{TestSocket,TestSync}`. The contract's named list omits `TestControl`, `TestMemory`, `DurableObjectStorageFake`, and `HostContract`; under the contract's own rule ("the wildcard surface is the contract") they are public API. Documentation drift, not a packaging defect. No root `test/` directory (the vitest suites) is packed.
5. **`devDependencies` remain in the packed manifests** (14 to 22 entries per package). pnpm and npm both keep the field when packing and ignore it on install. No action.

## Per-tarball inventory (run 2, identical to run 3)

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
| `smthrs` | `smthrs-1.0.0-rc.0.tgz` | 4219 | 11 | 1 | 1 | 1 | 1 | none | dist/cjs/package.json absent; devDependencies kept (14) |
| `@smthrs/step-cache` | `smthrs-step-cache-1.0.0-rc.0.tgz` | 58910 | 61 | 8 | 8 | 8 | 8 | none | devDependencies kept (16); migrations src/esm/cjs 1/1/1; src/test helpers 1 (public via ./*) |
| `@smthrs/sync` | `smthrs-sync-1.0.0-rc.0.tgz` | 170819 | 152 | 21 | 21 | 21 | 21 | none | devDependencies kept (16); src/test helpers 2 (public via ./*) |
| `@smthrs/kernel` | `smthrs-kernel-1.0.0-rc.0.tgz` | 192436 | 138 | 19 | 19 | 19 | 19 | none | devDependencies kept (16); src/test helpers 3 (public via ./*) |
| `@smthrs/engine-store` | `smthrs-engine-store-1.0.0-rc.0.tgz` | 942122 | 292 | 41 | 41 | 41 | 41 | none | devDependencies kept (21); migrations src/esm/cjs 2/2/2; src/test helpers 1 (public via ./*) |
| `@smthrs/model` | `smthrs-model-1.0.0-rc.0.tgz` | 243119 | 138 | 19 | 19 | 19 | 19 | none | devDependencies kept (16) |
| `@smthrs/memory` | `smthrs-memory-1.0.0-rc.0.tgz` | 151500 | 117 | 16 | 16 | 16 | 16 | none | devDependencies kept (16); reference .sql files packed: 0/3; src/test helpers 1 (public via ./*) |
| `@smthrs/platform-browser` | `smthrs-platform-browser-1.0.0-rc.0.tgz` | 47688 | 124 | 17 | 17 | 17 | 17 | none | devDependencies kept (16) |
| `@smthrs/platform-node` | `smthrs-platform-node-1.0.0-rc.0.tgz` | 111552 | 40 | 5 | 5 | 5 | 5 | none | devDependencies kept (17) |
| `@smthrs/platform-bun` | `smthrs-platform-bun-1.0.0-rc.0.tgz` | 9778 | 26 | 3 | 3 | 3 | 3 | none | devDependencies kept (17) |
| `@smthrs/registry` | `smthrs-registry-1.0.0-rc.0.tgz` | 187407 | 96 | 13 | 13 | 13 | 13 | none | devDependencies kept (21) |
| `@smthrs/control` | `smthrs-control-1.0.0-rc.0.tgz` | 333636 | 180 | 25 | 25 | 25 | 25 | none | devDependencies kept (21); src/test helpers 1 (public via ./*) |
| `@smthrs/gateway` | `smthrs-gateway-1.0.0-rc.0.tgz` | 99391 | 82 | 11 | 11 | 11 | 11 | none | devDependencies kept (22); src/test helpers 1 (public via ./*) |
| `@smthrs/harness` | `smthrs-harness-1.0.0-rc.0.tgz` | 759969 | 222 | 31 | 31 | 31 | 31 | none | devDependencies kept (18) |
| `@smthrs/mcp` | `smthrs-mcp-1.0.0-rc.0.tgz` | 31051 | 47 | 6 | 6 | 6 | 6 | none | devDependencies kept (18) |
| `@smthrs/sandbox` | `smthrs-sandbox-1.0.0-rc.0.tgz` | 75641 | 250 | 35 | 35 | 35 | 35 | none | devDependencies kept (16) |
| `@smthrs/std` | `smthrs-std-1.0.0-rc.0.tgz` | 397341 | 313 | 44 | 44 | 44 | 44 | none | devDependencies kept (17) |
| `@smthrs/agent` | `smthrs-agent-1.0.0-rc.0.tgz` | 479235 | 145 | 20 | 20 | 20 | 20 | none | devDependencies kept (18) |
| `@smthrs/testing` | `smthrs-testing-1.0.0-rc.0.tgz` | 286517 | 194 | 27 | 27 | 27 | 27 | none | devDependencies kept (17) |
| `@smthrs/time-travel` | `smthrs-time-travel-1.0.0-rc.0.tgz` | 231839 | 131 | 18 | 18 | 18 | 18 | none | devDependencies kept (22) |
| `@smthrs/flows` | `smthrs-flows-1.0.0-rc.0.tgz` | 45321 | 26 | 3 | 3 | 3 | 3 | none | devDependencies kept (16) |
| `@smthrs/cli` | `smthrs-cli-1.0.0-rc.0.tgz` | 708475 | 206 | 28 | 28 | 28 | 28 | none | devDependencies kept (16) |

packages=40 violations=0

## SHA-256 of the packed tarballs (byte-identical across two pack runs)

```
1ee72d5f95e7a3981db4803fae3f9a9c601a3c8fc0406ddb893a0d335cb1f123  smthrs-1.0.0-rc.0.tgz
49173b7ebd6ff141aad12b35ff931519111c62098777c968e8da7d1e91e43c18  smthrs-agent-1.0.0-rc.0.tgz
063bac3188d7f595e3908a2e8ce28ed19c79c35356c59cae757e6623c52d9992  smthrs-artifacts-1.0.0-rc.0.tgz
7aab09d2fbe2965d2feda42cc90f131fc6babc6640c3213c4d720536e83f0b22  smthrs-canonical-1.0.0-rc.0.tgz
99552175a8db3edb7797984c6de8e34c3bb69bb00aa08ff1360a1c8e10563096  smthrs-capability-1.0.0-rc.0.tgz
8f0ab256a066b4699c65ad2bc7a9992dd306bab42a2573fcec83e177eaf97573  smthrs-cli-1.0.0-rc.0.tgz
3093a374b7fbc359f3236cb443b4f04c655ab2de359011f41e1615f13184abef  smthrs-control-1.0.0-rc.0.tgz
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
f0e6315f9ef50ba118104b6884c792e55ac555fc672ec0908bb0d770bd2b78da  smthrs-memory-1.0.0-rc.0.tgz
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
git clone --shared <clean-checkout> <dir> && git -C <dir> checkout --detach cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba
cd <dir> && corepack pnpm install --frozen-lockfile --offline --ignore-scripts
corepack pnpm -r --no-bail --if-present $(node scripts/pack-release.mjs --names | sed "s/^/--filter=/") run build
node scripts/pack-release.mjs <packs>
node /private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/npm-pack/inspect.mjs <dir> <packs> inspect.json
```
