# Phase 7 gate: consumer-fixtures

Verdict: PASS

The 40 public packages, packed from a built clean checkout of `v1/rc0-migration`
at `cd14388ed7`, install into fresh Node and Bun consumer projects from `file:`
tarballs, resolve through their published `dist` exports, import their root
entries in both runtimes once the one declared optional peer is present, and
run the README "Quick start" program to `Hello, Ada.` with exit 0 under Node
24.18.0, Node 22.19.0 (the rc-contract section 1 floor), and Bun 1.4.0. Each
fixture holds exactly one `effect`, at `4.0.0-rc.108`.

This file supersedes the 2026-08-31 00:07 PT evidence taken at `20b32c6316` in
`migration/clean-checkout-2` (that directory no longer exists). The superseded
file is kept beside this one as `consumer-fixtures-prev-20b32c6316.md`. The
result is unchanged. Two fixture caveats recorded there reproduce here and are
restated below; one footprint change is new and is explained in "Caveats".

## Environment

| Item | Value |
| --- | --- |
| Host | macOS 26.2 (build 25C56), Darwin 25.2.0, arm64 |
| Date | 2026-08-31 12:01 to 12:12 UTC (05:01 to 05:12 PT) |
| Node | v24.18.0 (`/Users/williamcory/.nvm/versions/node/v24.18.0/bin/node`); v22.19.0 (`/Users/williamcory/.nvm/versions/node/v22.19.0/bin/node`) for the floor run |
| npm | 11.16.0 |
| Bun | 1.4.0-canary.1+6618e7f7e (`bun --version` prints `1.4.0`; `/Users/williamcory/.bun/bin/bun`) |
| pnpm | 11.21.0 via corepack from `packageManager: pnpm@11.21.0` |
| Clean checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4` (written as `<clean-checkout-4>` below), branch `v1/rc0-migration`, HEAD `cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba`, `vendor/jj` at `47589ada70`, installed by the clean-install gate (`00-clean-install.md`) |
| Fixture root | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/phase7/consumers` (written as `<consumers>` below) |
| Host load | load averages 13.73 at start; 62.82 to 82.39 during the build, while five other Phase 7 lanes ran in the same checkout |
| Registry state | `npm view @smthrs/flow version` exits with `E404 Not Found - GET https://registry.npmjs.org/@smthrs%2fflow`: no `@smthrs/*` package exists on the registry at any version, so every transitive `@smthrs/*@1.0.0-rc.0` edge must be satisfied from the tarballs (`<consumers>/registry-check.log`) |

`SMITHERS_HOME` was unset in the calling shell and was additionally stripped
(`env -u SMITHERS_HOME`) from every build, pack, install, and run.

rc-contract.md section 1 describes the Bun fixture as running under Bun
1.3.14. The host has Bun 1.4.0-canary.1, the same binary the clean-install gate
and the CI matrix on this host use; no 1.3.14 is installed. The fixture result
is recorded against 1.4.0.

## Build and pack

`scripts/pack-release.mjs` refuses to pack a package whose `src/**/*.ts` lacks
a matching `dist/esm/*.js`, `dist/esm/*.d.ts`, and `dist/cjs/*.js`
(`assertBuilt`), and the clean checkout had no `dist/` directories
(`ls -d packages/*/dist` matched nothing), so the 40 public packages were built
first in the publication order `node scripts/pack-release.mjs --list` prints
(`<consumers>/pack-order.txt`, 40 lines, `canonical` first, `cli` last). All
commands ran from `<clean-checkout-4>`.

| Command | Exit | Result |
| --- | --- | --- |
| `for d in $(cat pack-order.txt); do env -u SMITHERS_HOME corepack pnpm --dir packages/$d run build; done` (`<consumers>/build-all.sh`) | 0 | 40 of 40 builds succeeded, 12:01:12 to 12:05:21 UTC, `BUILD_END ... built=40 failed=0`, `ALL_BUILDS_OK`; per-package logs in `<consumers>/build-logs/`, summary in `<consumers>/build.log` |
| `node <consumers>/check-dist.mjs <clean-checkout-4> pack-order.txt` (every `src/**/*.ts` has esm js, esm d.ts, cjs js) | 0 | `ALL_40_DIST_COMPLETE` (`<consumers>/check-dist.log`) |
| `env -u SMITHERS_HOME node scripts/pack-release.mjs <consumers>/tarballs` | 0 | first attempt, 12:05:46 to 12:07:32 UTC; 40 tarballs plus `manifest.json`, 9,570,268 bytes, every manifest entry `1.0.0-rc.0` (`<consumers>/pack.log`) |
| `git status --porcelain` after build, pack, fixtures, and smoke | 0 | empty; HEAD still `cd14388ed7`; `dist/` is gitignored and the pack stages copies under a temp directory |

Concurrency note. The `exports-types-sync` lane (run 4) ran the identical serial
build loop in `<clean-checkout-4>` at the same time, in lockstep with this one
(its log: `<phase7>/exports-types-sync/run4/release-build.log`). Each
`scripts/build.mjs` deletes and re-emits `dist/`, so two loops on one package
race; that lane's `patterns` build exited 1 after 1 s while this lane's
`patterns` build exited 0. Both loops ended at 12:05:21 UTC. The completeness
check above ran at 12:05:32, after both loops had exited and with no
`scripts/build.mjs` process alive, and the tarball check below re-proves
completeness on the artifacts themselves, so the race cannot have reached the
fixtures.

### Tarball verification

`<consumers>/verify-tarballs.sh` opened every tarball (`tar -tzf`) and read
its inner `package.json` (`<consumers>/tarball-verify.log`, one line per
package, `checked=40 failed=0`, `ALL_40_TARBALLS_OK`). For all 40: every
shipped `package/src/**/*.ts` has its `dist/esm` js and d.ts and `dist/cjs` js
in the same tarball; `exports["."]` is a `{ types, import, require }` object
under `./dist/esm` and `./dist/cjs` (rewritten from `publishConfig.exports`);
`version` is `1.0.0-rc.0`; `publishConfig.tag` is `rc`; no `private` flag; no
`workspace:` range in `dependencies`, `peerDependencies`, or
`optionalDependencies`; zero entries under `package/test/`, `package/legacy/`,
or `package/node_modules/`.

Aggregate SHA-256 of the sorted `shasum -a 256` lines of the 40 tarballs:
`c602de1ed5799aaa2b255c021bed526d447ee1b4254888209ad0dbcda55d33d9`
(`<consumers>/tarballs.sha256`, per-file lines plus the aggregate). The digest
differs from the superseded run's `eac5bb9b...` because that run packed
`20b32c6316`; this pack is `cd14388ed7`.

| Package | Tarball | Size | Note |
| --- | --- | --- | --- |
| `@smthrs/canonical@1.0.0-rc.0` | `smthrs-canonical-1.0.0-rc.0.tgz` | 9.5 kB | |
| `@smthrs/capability@1.0.0-rc.0` | `smthrs-capability-1.0.0-rc.0.tgz` | 29.0 kB | |
| `@smthrs/crypto@1.0.0-rc.0` | `smthrs-crypto-1.0.0-rc.0.tgz` | 5.8 kB | |
| `@smthrs/artifacts@1.0.0-rc.0` | `smthrs-artifacts-1.0.0-rc.0.tgz` | 100.4 kB | |
| `@smthrs/core@1.0.0-rc.0` | `smthrs-core-1.0.0-rc.0.tgz` | 121.8 kB | |
| `@smthrs/database@1.0.0-rc.0` | `smthrs-database-1.0.0-rc.0.tgz` | 85.9 kB | |
| `@smthrs/jj@1.0.0-rc.0` | `smthrs-jj-1.0.0-rc.0.tgz` | 1425.7 kB | |
| `@smthrs/journal@1.0.0-rc.0` | `smthrs-journal-1.0.0-rc.0.tgz` | 147.3 kB | |
| `@smthrs/keys@1.0.0-rc.0` | `smthrs-keys-1.0.0-rc.0.tgz` | 6.1 kB | |
| `@smthrs/migrate@1.0.0-rc.0` | `smthrs-migrate-1.0.0-rc.0.tgz` | 777.8 kB | |
| `@smthrs/notifications@1.0.0-rc.0` | `smthrs-notifications-1.0.0-rc.0.tgz` | 65.8 kB | |
| `@smthrs/observability@1.0.0-rc.0` | `smthrs-observability-1.0.0-rc.0.tgz` | 27.5 kB | |
| `@smthrs/patterns@1.0.0-rc.0` | `smthrs-patterns-1.0.0-rc.0.tgz` | 248.7 kB | |
| `@smthrs/plan@1.0.0-rc.0` | `smthrs-plan-1.0.0-rc.0.tgz` | 184.9 kB | |
| `@smthrs/flow@1.0.0-rc.0` | `smthrs-flow-1.0.0-rc.0.tgz` | 393.7 kB | |
| `@smthrs/engine@1.0.0-rc.0` | `smthrs-engine-1.0.0-rc.0.tgz` | 116.0 kB | |
| `@smthrs/plugin@1.0.0-rc.0` | `smthrs-plugin-1.0.0-rc.0.tgz` | 37.7 kB | |
| `@smthrs/run-store@1.0.0-rc.0` | `smthrs-run-store-1.0.0-rc.0.tgz` | 125.7 kB | |
| `smthrs@1.0.0-rc.0` | `smthrs-1.0.0-rc.0.tgz` | 4.1 kB | migration notice: load throws by design
| `@smthrs/step-cache@1.0.0-rc.0` | `smthrs-step-cache-1.0.0-rc.0.tgz` | 57.5 kB | |
| `@smthrs/sync@1.0.0-rc.0` | `smthrs-sync-1.0.0-rc.0.tgz` | 166.8 kB | |
| `@smthrs/kernel@1.0.0-rc.0` | `smthrs-kernel-1.0.0-rc.0.tgz` | 187.9 kB | |
| `@smthrs/engine-store@1.0.0-rc.0` | `smthrs-engine-store-1.0.0-rc.0.tgz` | 920.0 kB | |
| `@smthrs/model@1.0.0-rc.0` | `smthrs-model-1.0.0-rc.0.tgz` | 237.4 kB | |
| `@smthrs/memory@1.0.0-rc.0` | `smthrs-memory-1.0.0-rc.0.tgz` | 147.9 kB | |
| `@smthrs/platform-browser@1.0.0-rc.0` | `smthrs-platform-browser-1.0.0-rc.0.tgz` | 46.6 kB | |
| `@smthrs/platform-node@1.0.0-rc.0` | `smthrs-platform-node-1.0.0-rc.0.tgz` | 108.9 kB | |
| `@smthrs/platform-bun@1.0.0-rc.0` | `smthrs-platform-bun-1.0.0-rc.0.tgz` | 9.5 kB | |
| `@smthrs/registry@1.0.0-rc.0` | `smthrs-registry-1.0.0-rc.0.tgz` | 183.0 kB | |
| `@smthrs/control@1.0.0-rc.0` | `smthrs-control-1.0.0-rc.0.tgz` | 325.8 kB | |
| `@smthrs/gateway@1.0.0-rc.0` | `smthrs-gateway-1.0.0-rc.0.tgz` | 97.1 kB | |
| `@smthrs/harness@1.0.0-rc.0` | `smthrs-harness-1.0.0-rc.0.tgz` | 742.2 kB | |
| `@smthrs/mcp@1.0.0-rc.0` | `smthrs-mcp-1.0.0-rc.0.tgz` | 30.3 kB | |
| `@smthrs/sandbox@1.0.0-rc.0` | `smthrs-sandbox-1.0.0-rc.0.tgz` | 73.9 kB | |
| `@smthrs/std@1.0.0-rc.0` | `smthrs-std-1.0.0-rc.0.tgz` | 388.0 kB | |
| `@smthrs/agent@1.0.0-rc.0` | `smthrs-agent-1.0.0-rc.0.tgz` | 468.0 kB | |
| `@smthrs/testing@1.0.0-rc.0` | `smthrs-testing-1.0.0-rc.0.tgz` | 279.8 kB | |
| `@smthrs/time-travel@1.0.0-rc.0` | `smthrs-time-travel-1.0.0-rc.0.tgz` | 226.4 kB | |
| `@smthrs/flows@1.0.0-rc.0` | `smthrs-flows-1.0.0-rc.0.tgz` | 44.3 kB | |
| `@smthrs/cli@1.0.0-rc.0` | `smthrs-cli-1.0.0-rc.0.tgz` | 691.2 kB | |

Sizes are the `smoke-release.mjs` readings (`<consumers>/smoke-release.log`),
in publication order.

## Fixtures

`<consumers>/make-fixture.mjs` writes each fixture's `package.json`: `private:
true`, `type: "module"`, and `dependencies` naming the 40 tarballs as
`file:../tarballs/<file>.tgz` (read from `manifest.json`) plus the two registry
dependencies the README install line names, `effect@4.0.0-rc.108` and
`@effect/platform-node@4.0.0-rc.108` (42 dependencies). With `--overrides` it
adds an `overrides` map with the same 42 entries.

`quickstart.ts` is the README "Quick start" code block, extracted with `awk`
from the ` ```ts ` fence between the `## Quick start` and `## Examples` headings
of `<clean-checkout-4>/README.md` (SHA-256 `e986d822...`, byte-identical to the
README the superseded run extracted from). The extraction is 38 lines, SHA-256
`fdc99f73...`, byte-identical to `<phase7>/consumers-quickstart.ts` from the
superseded runs. Each fixture holds its own copy.

`<consumers>/import-roots.mjs` imports the root entry of every packed package
through the fixture's `node_modules` and requires the unscoped `smthrs` notice
to throw `smthrs 1.0 is a migration notice, not a runtime.` on load
(rc-contract.md section 3.3). The same file runs under `node` and `bun`.

`<consumers>/count-effect.sh` lists every installed copy of `effect` and
`@effect/platform-node-shared` with its version, following symlinks and
deduplicating by real path. Its first version had two bugs (a `-path` glob that
missed root-level copies, and a relative `require`), so the `effect-count.log`
and `effect-count-2.log` files inside each fixture under-report. The corrected
script produced `effect-count-final.log` in each fixture after every install
step had finished; those two files are the readings quoted below.

### Node fixture (`<consumers>/node-consumer`)

Driver: `<consumers>/run-node.sh`, transcript `<consumers>/node-run.log`,
12:08:00 to 12:09:17 UTC.

| Command | Exit | Final lines |
| --- | --- | --- |
| `npm install --no-audit --no-fund` | 0 | `added 93 packages in 1m`; one `npm warn ERESOLVE overriding peer dependency` line with no detail block (the `@effect/platform-node-shared` peer, see "Caveats"); one `allow-scripts` warning for `msgpackr-extract@3.0.4` (its install script stayed blocked; nothing needed it). Log `npm-install.log` |
| `node quickstart.ts` (v24.18.0) | 0 | `Hello, Ada.` and nothing else on stdout or stderr (12 bytes). Log `node-quickstart.log` |
| `/Users/williamcory/.nvm/versions/node/v22.19.0/bin/node quickstart.ts` | 0 | `Hello, Ada.`, no type-stripping warning (12 bytes). Log `node22-quickstart.log` |
| `npm ls @smthrs/flow @smthrs/engine effect @effect/platform-node` | 1 | tree printed; `effect@4.0.0-rc.108 deduped invalid: "^4.0.0-rc.112" from node_modules/@effect/platform-node/node_modules/@effect/platform-node-shared` (see "Caveats"). Log `npm-ls.log` |
| `npm ls --all \| grep -c "@smthrs/.*deduped"` | 0 | `175` nested `@smthrs/*` edges deduped against the root `file:` installs |
| `node import-roots.mjs ../tarballs/manifest.json` | 1 | `39 ok, 1 failed`: `@smthrs/platform-bun`, `Cannot find package '@effect/platform-bun' imported from .../@smthrs/platform-bun/dist/esm/BunHost.js`. Log `node-import-roots.log` |
| `npm install --save-exact --no-audit --no-fund @effect/platform-bun@4.0.0-rc.108` | 0 | installed; the same `allow-scripts` warning. Log `npm-install-peer.log` |
| `node import-roots.mjs ../tarballs/manifest.json` (after the peer) | 0 | `40 ok, 0 failed`. Log `node-import-roots-2.log` |
| `node quickstart.ts` (after the peer) | 0 | `Hello, Ada.` (12 bytes). Log `node-quickstart-2.log` |

Resolution (`resolve.log`): `import.meta.resolve("@smthrs/flow")` is
`node_modules/@smthrs/flow/dist/esm/index.js`, `@smthrs/engine` likewise,
`effect` is `node_modules/effect/dist/index.js`, and the installed
`@smthrs/flow/package.json` `exports["."]` is
`{"types":"./dist/esm/index.d.ts","import":"./dist/esm/index.js","require":"./dist/cjs/index.js"}`.
The fixture runs published artifacts, not workspace sources.

Layout (`effect-count-final.log`): exactly one `effect` on disk,
`node_modules/effect` at `4.0.0-rc.108`; two `@effect/platform-node-shared`
copies, `node_modules/@effect/platform-node-shared` at `4.0.0-rc.108` and
`node_modules/@effect/platform-node/node_modules/@effect/platform-node-shared`
at `4.0.0-rc.112`; `node_modules/@smthrs` holds 39 directories plus
`node_modules/smthrs`; `node_modules` is 176 MB. npm satisfied every nested
exact `@smthrs/*@1.0.0-rc.0` edge from the root `file:` installs with no
overrides.

### Bun fixture (`<consumers>/bun-consumer`)

Driver: `<consumers>/run-bun.sh`, transcript `<consumers>/bun-run.log`,
12:08:02 to 12:08:25 UTC.

| Command | Exit | Final lines |
| --- | --- | --- |
| `bun install` (42 dependencies, no overrides) | 1 | 162 lines of `error: @smthrs/<name>@1.0.0-rc.0 failed to resolve`, the first `error: @smthrs/database@1.0.0-rc.0 failed to resolve`, with `error: GET https://registry.npmjs.org/@smthrs%2fjj - 404` and the like beside them. Log `bun-install-no-overrides.log` |
| `rm -rf node_modules bun.lock`, rewrite `package.json` with `--overrides`, `bun install` | 0 | `Resolved, downloaded and extracted [40]`, `93 packages installed [4.41s]`. Log `bun-install.log` |
| `bun quickstart.ts` | 0 | `Hello, Ada.` and nothing else. Log `bun-quickstart.log` |
| `bun import-roots.mjs ../tarballs/manifest.json` | 1 | `39 ok, 1 failed`: `@smthrs/platform-bun`, `Cannot find module '@effect/platform-bun/BunChildProcessSpawner' from .../@smthrs/platform-bun/dist/esm/BunHost.js`. Log `bun-import-roots.log` |
| `bun add --exact @effect/platform-bun@4.0.0-rc.108` | 0 | `installed @effect/platform-bun@4.0.0-rc.108`, `42 packages installed [1199.00ms]`. Log `bun-add-peer.log` |
| `bun import-roots.mjs ../tarballs/manifest.json` (after the peer) | 0 | `40 ok, 0 failed`. Log `bun-import-roots-2.log` |
| `bun quickstart.ts` (after the peer) | 0 | `Hello, Ada.`. Log `bun-quickstart-2.log` |

Resolution (`resolve.log`): `Bun.resolveSync("@smthrs/flow")` is
`node_modules/@smthrs/flow/dist/esm/index.js`, `@smthrs/engine` likewise,
`effect` is `node_modules/effect/dist/index.js`.

Layout (`effect-count-final.log`): exactly one `effect` on disk,
`node_modules/effect` at `4.0.0-rc.108`; six `@effect/platform-node-shared`
copies, one hoisted at `4.0.0-rc.112` and five nested at `4.0.0-rc.108` under
`@smthrs/{cli,gateway,migrate,platform-bun,platform-node}`;
`node_modules/@smthrs` holds 39 directories plus `node_modules/smthrs`;
`node_modules` is 178 MB; `bun.lock` is 40,854 bytes.

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

The one first-run failure in each fixture is by design. `@smthrs/platform-bun`
declares `@effect/platform-bun@4.0.0-rc.108` as an optional peer
(`peerDependenciesMeta`), the consumer is told to bring it, and the
repository's own smoke installs optional peers for exactly this reason (the
header comment of `scripts/smoke-release.mjs`). The other optional peers in
the set, `@smthrs/kernel` `vitest@4.1.9` and `@smthrs/testing`
`@effect/vitest@4.0.0-rc.108` and `vitest@^4.1.0`, are not needed to import a
root entry: both fixtures reach `40 ok, 0 failed` with only
`@effect/platform-bun` added. The quick-start was re-run after the peer add in
both fixtures and still prints `Hello, Ada.` with exit 0; each fixture still
holds exactly one `effect` directory.

## Repository smoke on the same tarballs

`env -u SMITHERS_HOME node scripts/smoke-release.mjs <consumers>/tarballs`
from `<clean-checkout-4>` (the `//scripts:releaseSmoke` runner) printed 40
`smoke ok` lines and the final line
`release smoke holds: 40 tarballs install, import, and typecheck on node 24.18.0.`
(`<consumers>/smoke-release.log`; the script prints that line only after every
ESM import, CJS require, notice check, and the `tsc --noEmit` of `smoke.mts`
have passed). It creates its own external pnpm project under `$TMPDIR`,
overrides every `@smthrs/*` name to its tarball, installs the optional peers,
imports every packed entry as ESM and requires it as CJS, and typechecks
against the shipped declarations. A second run with the exit status captured
is recorded in `<consumers>/smoke-release-2.log`: exit 0, 2026-08-31T12:10:42Z to 2026-08-31T12:12:11Z, the same 40 `smoke ok` lines and the same final line.

## Caveats

### `@effect/platform-node-shared` drift on the registry

Unchanged from the superseded run and reproduced here.
`@effect/platform-node@4.0.0-rc.108` declares
`@effect/platform-node-shared: ^4.0.0-rc.108`; the registry now serves
`4.0.0-rc.112` for that range, and that version's peer is
`effect: ^4.0.0-rc.112`. In the fixtures:

- Both fixtures hold exactly one `effect` at `4.0.0-rc.108`, so the README's
  single-instance requirement holds. A `@effect/platform-node-shared@4.0.0-rc.112`
  copy is installed beside the `4.0.0-rc.108` copies the `@smthrs` packages
  pin (npm: 2 copies, rc.108 at the root and rc.112 nested under
  `@effect/platform-node`, the reverse of the superseded run's placement; Bun:
  6, one hoisted rc.112 and five nested rc.108).
- `npm install` prints `npm warn ERESOLVE overriding peer dependency` and
  `npm ls` exits 1 with `invalid: "^4.0.0-rc.112"` because rc.112's peer range
  is unsatisfied. The install and the quick-start are unaffected, and the
  quick-start does not load the drifted module.

The workspace's lockfiles pin `@effect/platform-node-shared@4.0.0-rc.108`, so
the repository never sees this; only a fresh consumer following the README
install line does. The remedy for a consumer is an `overrides` entry pinning
`@effect/platform-node-shared@4.0.0-rc.108`. This belongs in the release notes
or the README install paragraph; it is reported for the orchestrator to route
and no fix was made in the clean checkout.

### Install footprint changed since `20b32c6316`

Both fixtures now install 93 packages where the superseded run installed 136
(npm) and 137 (Bun). The cause is in the tree, not the fixtures:
`git diff 20b32c6316..cd14388ed7 -- 'packages/*/package.json'` shows one
dependency change, `packages/testing/package.json` moving `@effect/vitest`
from `dependencies` to an optional peer and adding `vitest ^4.1.0` as a second
optional peer. The packed `@smthrs/testing` manifest carries exactly that
shape, so a consumer no longer pulls the vitest tree unless it opts in. No
other tarball's dependency list changed. Observation for the owner of the
peer ranges: `@smthrs/kernel` pins its optional `vitest` peer at `4.1.9` while
`@smthrs/testing` declares `^4.1.0`; both are optional and neither affects
this gate.

### Concurrent build race in the shared checkout

Recorded above under "Build and pack". The dist completeness check and the
tarball verification both ran after every build loop had exited, so the packed
artifacts are proven complete independent of the race.

## Artifacts

All under `<consumers>`:

- `environment.txt`, `registry-check.log`, `pack-order.txt`
- `build-all.sh`, `build.log`, `build-logs/<package>.log` (40 files)
- `check-dist.mjs`, `check-dist.log`
- `pack.log`, `tarballs/` (40 `.tgz` plus `manifest.json`), `tarballs.sha256`
- `verify-tarballs.sh`, `tarball-verify.log`, `tarball-table.md`
- `make-fixture.mjs`, `import-roots.mjs`, `count-effect.sh`, `quickstart.ts`
  (the verbatim README extraction)
- `run-node.sh`, `node-run.log`, `node-consumer/`: `package.json`,
  `package-lock.json`, `quickstart.ts`, `import-roots.mjs`, `npm-install.log`,
  `node-quickstart.log`, `node22-quickstart.log`, `resolve.log`, `npm-ls.log`,
  `node-import-roots.log`, `npm-install-peer.log`, `node-import-roots-2.log`,
  `node-quickstart-2.log`, `effect-count-final.log`, `node_modules/` (176 MB)
- `run-bun.sh`, `bun-run.log`, `bun-consumer/`: `package.json`, `bun.lock`,
  `quickstart.ts`, `import-roots.mjs`, `bun-install-no-overrides.log`,
  `bun-install.log`, `bun-quickstart.log`, `resolve.log`,
  `bun-import-roots.log`, `bun-add-peer.log`, `bun-import-roots-2.log`,
  `bun-quickstart-2.log`, `effect-count-final.log`, `node_modules/` (178 MB)
- `smoke-release.log`, `smoke-release-2.log`

The clean checkout is unchanged: `git status --porcelain` is empty at HEAD
`cd14388ed7` after the build, pack, fixtures, and smoke. Nothing was edited in
`/Users/williamcory/smithers`; the one read of that repository was the
read-only `git diff` quoted in "Caveats".

## Verdict

PASS. All 40 public packages pack from built artifacts at `cd14388ed7`,
install into fresh Node (npm 11.16.0) and Bun (1.4.0) consumer fixtures from
`file:` tarballs, resolve through their published `dist` exports, import their
root entries in both runtimes once the one declared optional peer is present,
and the README quick-start prints `Hello, Ada.` with exit 0 under Node
24.18.0, Node 22.19.0, and Bun 1.4.0 with a single `effect@4.0.0-rc.108`
instance in each fixture.
