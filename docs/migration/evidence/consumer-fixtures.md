# Phase 7 gate: consumer-fixtures

Verdict: PASS

The 40 public packages, packed from a built clean checkout of `v1/rc0-migration`
at `20b32c6316`, install into fresh Node and Bun consumer projects from `file:`
tarballs, resolve through their published `dist` exports, and run the README
"Quick start" program to `Hello, Ada.` with exit 0 under Node 24.18.0,
Node 22.19.0 (the rc-contract floor), and Bun 1.4.0. Each fixture holds exactly
one `effect` at `4.0.0-rc.108`.

This file supersedes the 2026-08-30 15:56 evidence taken at `9c464343f0` in
`migration/clean-checkout` (that directory no longer exists). The result is
unchanged; the two fixture caveats recorded there reproduce byte-for-byte in
shape and are restated below.

## Environment

| Item | Value |
| --- | --- |
| Host | macOS 26.2 (Darwin 25.2.0), arm64; load averages 2.71 2.66 3.81 at start |
| Date | 2026-08-31 06:58 to 07:07 UTC (2026-08-30 23:58 to 2026-08-31 00:07 PT) |
| Node | v24.18.0 (`/Users/williamcory/.nvm/versions/node/v24.18.0/bin/node`); also v22.19.0 for the floor run |
| npm | 11.16.0 |
| Bun | 1.4.0-canary.1+6618e7f7e (`bun --version` prints `1.4.0`) |
| pnpm (corepack, `packageManager: pnpm@11.21.0`) | 11.21.0 |
| Clean checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-2` at `20b32c6316487497301db74ec70cbe951428ef53` (`v1/rc0-migration`), installed by the clean-install gate |
| Fixture root | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/phase7/consumers` (written as `<consumers>` below) |
| Registry state | `@smthrs/flow` returns `E404` from registry.npmjs.org: no `@smthrs/*` package exists on the registry at any version, so every transitive `@smthrs/*@1.0.0-rc.0` edge must be satisfied from the tarballs |

`SMITHERS_HOME` was unset (`env -u SMITHERS_HOME`) for every build, pack,
install, and run.

rc-contract.md section 1 describes this fixture as running under Bun 1.3.14.
The host has Bun 1.4.0-canary.1, the same binary the clean-install gate and
the CI matrix on this host use; no 1.3.14 is installed. The fixture result is
recorded against 1.4.0.

## Build and pack

`scripts/pack-release.mjs` refuses to pack a package whose `src/**/*.ts` lacks
a matching `dist/esm/*.js`, `dist/esm/*.d.ts`, and `dist/cjs/*.js`
(`assertBuilt`), and the clean checkout had no `dist/` directories, so the 40
public packages were built first in the publication order
`node scripts/pack-release.mjs --list` prints. All commands ran from the clean
checkout root.

| Command | Exit | Result |
| --- | --- | --- |
| `for d in $(node scripts/pack-release.mjs --list); do corepack pnpm --dir packages/$d run build; done` | 0 | 40 of 40 builds succeeded, 06:58:20 to 07:01:56 UTC (`ALL_BUILDS_OK`); log `<consumers>/build.log` |
| dist completeness check (every `src/**/*.ts` has esm js, esm d.ts, cjs js) | 0 | `ALL_40_DIST_COMPLETE` |
| `node scripts/pack-release.mjs <consumers>/tarballs` | 0 | first attempt; 40 tarballs plus `manifest.json`, 9.2 MB, every entry `1.0.0-rc.0`; log `<consumers>/pack.log` |
| `git status --porcelain` afterwards | 0 | empty; `dist/` is gitignored and the pack stages copies in a temp directory |

Three other Phase 7 lanes were running in the same checkout during the build
(`pnpm -r run build`, `pnpm -r run test`, `smithers-build build //packages/...`).
Both `pnpm -r run build` and `build.mjs` delete and re-emit `dist/`, which is
the race the npm-pack gate hit. The completeness check above ran after every
concurrent build process had exited and before the pack, and the tarball check
below re-proves completeness on the artifacts themselves, so the race cannot
have reached the fixtures.

### Tarball verification

Every tarball was opened (`tar -tzf`) and its inner `package.json` read
(`<consumers>/tarball-verify.log`, one line per package, `ALL_40_TARBALLS_OK`).
For all 40: every shipped `package/src/**/*.ts` has its `dist/esm` js and d.ts
and `dist/cjs` js in the same tarball; `exports["."]` is a
`{ types, import, require }` object under `./dist/esm` and `./dist/cjs`
(rewritten from `publishConfig.exports`); `version` is `1.0.0-rc.0`;
`publishConfig.tag` is `rc`; no `private` flag; no `workspace:` range; zero
entries under `package/test/`, `legacy/`, or `node_modules/`.

Aggregate SHA-256 of the sorted `shasum -a 256` lines of the 40 tarballs:
`eac5bb9b2ca2a168d5d22ece1f2943a4da482aefc68661e88c032a45f60d7ba7`
(`<consumers>/tarballs.sha256`). The digest differs from the npm-pack gate's
`83a0b02c...` because that gate packed `9c464343f0`; this pack is `20b32c6316`.

## Fixtures

`<consumers>/make-fixture.mjs` writes each fixture's `package.json`: `private:
true`, `type: "module"`, and `dependencies` naming the 40 tarballs as
`file:../tarballs/<file>.tgz` (read from `manifest.json`) plus the two registry
dependencies the README install line names, `effect@4.0.0-rc.108` and
`@effect/platform-node@4.0.0-rc.108`. `quickstart.ts` is the README "Quick
start" code block, extracted with `awk` from the block between the
`## Quick start` and `## Examples` headings of the clean checkout's
`README.md` (SHA-256 `e986d822...`), 38 lines, byte-identical to the
extraction the superseded run made (`<consumers>/../consumers-quickstart.ts`).
Each fixture holds its own copy.

### Node fixture (`<consumers>/node-consumer`)

| Command | Exit | Final lines |
| --- | --- | --- |
| `npm install --no-audit --no-fund` | 0 | `added 136 packages in 31s`; one `allow-scripts` warning for `msgpackr-extract@3.0.4` (its install script stayed blocked; nothing needed it). Log `npm-install.log` |
| `node quickstart.ts` (v24.18.0) | 0 | `Hello, Ada.` and nothing else on stdout or stderr. Log `node-quickstart.log` |
| `/Users/williamcory/.nvm/versions/node/v22.19.0/bin/node quickstart.ts` | 0 | `Hello, Ada.`, no type-stripping warning. Log `node22-quickstart.log` |
| `npm ls @smthrs/flow @smthrs/engine effect @effect/platform-node` | 1 | tree printed; `ELSPROBLEMS invalid: effect@4.0.0-rc.108` (see the caveat). Log `npm-ls.log` |

Resolution: `import.meta.resolve("@smthrs/flow")` is
`node_modules/@smthrs/flow/dist/esm/index.js`, `@smthrs/engine` likewise, and
the installed `@smthrs/flow/package.json` `exports["."]` is
`{"types":"./dist/esm/index.d.ts","import":"./dist/esm/index.js","require":"./dist/cjs/index.js"}`.
The fixture runs published artifacts, not workspace sources.

npm satisfied every nested exact `@smthrs/*@1.0.0-rc.0` edge from the root
`file:` installs with no overrides: `npm ls --all` shows 175 `@smthrs/*`
edges `deduped` against the root copies, `node_modules/@smthrs` holds 39
directories plus `node_modules/smthrs`, and exactly one `effect` directory
exists on disk, `node_modules/effect` at `4.0.0-rc.108`.

### Bun fixture (`<consumers>/bun-consumer`)

| Command | Exit | Final lines |
| --- | --- | --- |
| `bun install` (dependencies only, no overrides) | 1 | 162 lines of `error: @smthrs/<name>@1.0.0-rc.0 failed to resolve`. Log `bun-install-no-overrides.log` |
| `bun install` (same dependencies plus `overrides` mapping each of the 40 names to its tarball) | 0 | `137 packages installed [2.82s]`. Log `bun-install.log` |
| `bun quickstart.ts` | 0 | `Hello, Ada.` and nothing else. Log `bun-quickstart.log` |

Resolution: `Bun.resolveSync("@smthrs/flow")` is
`node_modules/@smthrs/flow/dist/esm/index.js`, `@smthrs/engine` likewise,
`effect` is `node_modules/effect/dist/index.js`. `node_modules/@smthrs` holds
39 directories plus `node_modules/smthrs`. Exactly one `effect` directory
exists on disk, at `4.0.0-rc.108`.

Bun, unlike npm, does not satisfy a nested exact `@smthrs/*@1.0.0-rc.0` edge
from a root `file:` tarball. It queries the registry, where no `@smthrs/*`
version exists, and the install fails. The `overrides` block is the same
technique `scripts/smoke-release.mjs` uses for the same reason. This is a
pre-publication fixture requirement, not a product defect: after `1.0.0-rc.0`
is published, a Bun consumer running the README install line resolves the
transitive edges from the registry.

The quick-start runs `FlowEngine.layerMemory`, so the Bun result stays inside
the rc-contract section 1 Bun claim (no durable flow under Bun).

### Root entry imports in both fixtures

`<consumers>/import-roots.mjs`, copied into each fixture and run there,
imports the root entry of every packed package through the fixture's
`node_modules` and requires the unscoped `smthrs` notice to throw
`smthrs 1.0 is a migration notice, not a runtime.` on load (rc-contract.md
section 3.3). This is the "imports each root entry" check rc-contract.md
section 1 attributes to the Bun consumer fixture.

| Fixture | First run | After adding the optional peer |
| --- | --- | --- |
| Node (v24.18.0) | `39 ok, 1 failed`: `@smthrs/platform-bun`, `Cannot find package '@effect/platform-bun'` from `dist/esm/BunHost.js` | `npm install --save-exact @effect/platform-bun@4.0.0-rc.108` (`added 2 packages`), then `40 ok, 0 failed`, exit 0 |
| Bun (1.4.0) | `39 ok, 1 failed`: `@smthrs/platform-bun`, `Cannot find module '@effect/platform-bun/BunChildProcessSpawner'` | `bun add --exact @effect/platform-bun@4.0.0-rc.108` (`42 packages installed`), then `40 ok, 0 failed`, exit 0 |

The one first-run failure is by design. `@smthrs/platform-bun` declares
`@effect/platform-bun@4.0.0-rc.108` as an optional peer
(`peerDependenciesMeta`), the consumer is told to bring it, and the
repository's own smoke installs optional peers for exactly this reason (the
header comment of `scripts/smoke-release.mjs`). `@smthrs/kernel`'s optional
peer `vitest@4.1.9` is not needed to import its root entry. The quick-start
was re-run after the peer add in both fixtures and still prints `Hello, Ada.`
with exit 0; each fixture still holds exactly one `effect` directory. Logs:
`node-import-roots.log`, `npm-install-peer.log`, `bun-import-roots.log`,
`bun-add-peer.log`.

## Repository smoke on the same tarballs

`node scripts/smoke-release.mjs <consumers>/tarballs` from the clean checkout
(the `//scripts:releaseSmoke` runner) exited 0:
`release smoke holds: 40 tarballs install, import, and typecheck on node 24.18.0.`
It creates its own external npm project, imports every packed entry as ESM and
requires it as CJS, and typechecks against the shipped declarations. Log
`<consumers>/smoke-release.log`.

## Caveat: `@effect/platform-node-shared` drift on the registry

Unchanged from the superseded run and reproduced here.
`@effect/platform-node@4.0.0-rc.108` declares
`@effect/platform-node-shared: ^4.0.0-rc.108`; the registry now serves
`4.0.0-rc.112` for that range, and that version's peer is
`effect: ^4.0.0-rc.112`. In the fixtures:

- Both fixtures hold exactly one `effect` at `4.0.0-rc.108`, so the README's
  single-instance requirement holds. A `@effect/platform-node-shared@4.0.0-rc.112`
  copy is installed beside the `4.0.0-rc.108` copies the `@smthrs` packages
  pin (npm: 2 copies of `platform-node-shared`; Bun: 6, one hoisted rc.112
  and five nested rc.108 under `cli`, `platform-bun`, `gateway`,
  `platform-node`, `migrate`).
- `npm ls` exits 1 with `ELSPROBLEMS: invalid: effect@4.0.0-rc.108` because
  rc.112's peer range is unsatisfied. The install and the quick-start are
  unaffected, and the quick-start does not load the drifted module.

The workspace's lockfiles pin `@effect/platform-node-shared@4.0.0-rc.108`, so
the repository never sees this; only a fresh consumer following the README
install line does. The remedy for a consumer is an `overrides` entry pinning
`@effect/platform-node-shared@4.0.0-rc.108`. This belongs in the release notes
or the README install paragraph; it is reported for the orchestrator to route
and no fix was made in the clean checkout.

## Artifacts

All under `<consumers>`:

- `build.log`, `pack.log`, `tarball-verify.log`, `tarballs.sha256`,
  `smoke-release.log`
- `tarballs/`: 40 `.tgz` plus `manifest.json`
- `make-fixture.mjs`, `import-roots.mjs`, `quickstart.ts` (the verbatim
  README extraction)
- `node-consumer/`: `package.json`, `package-lock.json`, `quickstart.ts`,
  `import-roots.mjs`, `npm-install.log`, `node-quickstart.log`,
  `node22-quickstart.log`, `npm-ls.log`, `npm-install-peer.log`,
  `node-import-roots.log`, `node_modules/` (209 MB)
- `bun-consumer/`: `package.json`, `bun.lock`, `quickstart.ts`,
  `import-roots.mjs`, `bun-install-no-overrides.log`, `bun-install.log`,
  `bun-quickstart.log`, `bun-add-peer.log`, `bun-import-roots.log`,
  `node_modules/` (212 MB)

The clean checkout is unchanged: `git status --porcelain` is empty at HEAD
`20b32c6316` after the build, pack, and smoke.

## Verdict

PASS. All 40 public packages pack from built artifacts at `20b32c6316`,
install into fresh Node (npm 11.16.0) and Bun (1.4.0) consumer fixtures from
`file:` tarballs, resolve through their published `dist` exports, import their
root entries in both runtimes once the one declared optional peer is present,
and the README quick-start prints `Hello, Ada.` with exit 0 under Node
24.18.0, Node 22.19.0, and Bun 1.4.0 with a single `effect@4.0.0-rc.108`
instance in each fixture.
