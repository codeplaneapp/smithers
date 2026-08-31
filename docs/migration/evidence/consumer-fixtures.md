# Phase 7 gate: consumer-fixtures

Verdict: PASS

This file supersedes the consumer-fixtures evidence taken at `cd14388ed7` on
2026-08-31 12:01 to 12:12 UTC; the superseded file is kept beside this one as
`consumer-fixtures-prev-cd14388ed7.md` (its predecessor at `20b32c6316`
remains as `consumer-fixtures-prev-20b32c6316.md`). This re-run validates
`341c8fa87e` and covers the surfaces the commits since `cd14388ed7` touched:
the README overrides recipe for `@effect/platform-node-shared` (polish-2, L2),
the repacked `smthrs` `dist/cjs/package.json` and `@smthrs/memory` `.sql`
files (polish-2, L3), and the `smithers init` scaffold whose launch now
refuses by naming the missing key instead of stranding an `accepted` row
(init-scaffold-launch, `13c077343b` + `363346c94e`).

The 40 public packages, packed from a fresh build of the clean checkout at
`341c8fa87e`, install into fresh Node and Bun consumer fixtures from `file:`
tarballs and run the README "Quick start" to `Hello, Ada.` with exit 0 under
Node 24.18.0, Node 22.19.0 (the rc-contract section 1 floor), and Bun 1.4.0.
With the README's one-line overrides recipe applied, every form of `npm ls`
exits 0 and each fixture holds exactly one `effect@4.0.0-rc.108` and exactly
one `@effect/platform-node-shared@4.0.0-rc.108`. The scaffolded launch with no
provider credential exits 1 naming `ANTHROPIC_API_KEY` and settles its run
`failed` on disk with zero `accepted` rows and zero engine rows.

## Environment

| Item | Value |
| --- | --- |
| Host | macOS 26.2 (build 25C56), Darwin 25.2.0, arm64 |
| Date | 2026-08-31 16:19 to 16:28 UTC (09:19 to 09:28 PT) |
| Node | v24.18.0 (`/Users/williamcory/.nvm/versions/node/v24.18.0/bin/node`); v22.19.0 (`/Users/williamcory/.nvm/versions/node/v22.19.0/bin/node`) for the floor run |
| npm | 11.16.0 |
| Bun | 1.4.0 (`/Users/williamcory/.bun/bin/bun`) |
| pnpm | 11.21.0 via corepack |
| Clean checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4` (written as `<clean-checkout-4>` below), branch `v1/rc0-migration`, HEAD `341c8fa87e2dadbe80d0f0d3258dae112a7d03d3`, `vendor/jj` initialized, frozen offline install from the setup step |
| Fixture root | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/phase7/consumers` (written as `<consumers>` below) |
| Host load | 3.37 at start, 20.48 when the build loop started, 21.99 to 27.09 during the release smoke; no step here is spawn-bound |
| Registry state | `npm view @smthrs/flow version` exits 1 with `E404 Not Found - GET https://registry.npmjs.org/@smthrs%2fflow`: no `@smthrs/*` package exists on the registry, so every transitive `@smthrs/*@1.0.0-rc.0` edge must be satisfied from the tarballs (`<consumers>/registry-check.log`) |

`SMITHERS_HOME` was stripped (`env -u SMITHERS_HOME`) from every build, pack,
install, and run. rc-contract.md section 1 describes the Bun fixture under Bun
1.3.14; the host has 1.4.0, the same binary the clean-install gate uses, and
the result is recorded against 1.4.0, unchanged from the superseded runs.

## Build and pack

The checkout had no `dist/` directories at the start of this run, so the 40
public packages were built first in the publication order
`node scripts/pack-release.mjs --list` prints (`<consumers>/pack-order.txt`,
40 lines, `canonical` first, `cli` last). All commands ran from
`<clean-checkout-4>`. No other lane ran a build in this checkout during this
run; the loop this time had the tree to itself.

| Command | Exit | Result |
| --- | --- | --- |
| `<consumers>/build-all.sh` (serial `corepack pnpm --dir packages/<d> run build` per pack-order line) | 0 | 40 of 40 builds, 16:19:56 to 16:22:25 UTC, `BUILD_END ... built=40 failed=0`, `ALL_BUILDS_OK` (`<consumers>/build.log`, per-package logs in `<consumers>/build-logs/`) |
| `node <consumers>/check-dist.mjs <clean-checkout-4> pack-order.txt` | 0 | `ALL_40_DIST_COMPLETE` (`<consumers>/check-dist.log`) |
| `env -u SMITHERS_HOME node scripts/pack-release.mjs <consumers>/tarballs` | 0 | 40 tarballs plus `manifest.json`, 9,460 KiB total, every manifest entry `1.0.0-rc.0` (`<consumers>/pack.log`) |
| `<consumers>/verify-tarballs.sh <consumers>/tarballs` | 0 | `checked=40 failed=0`, `ALL_40_TARBALLS_OK` (`<consumers>/tarball-verify.log`): every shipped `src/**/*.ts` has its `dist/esm` js and d.ts and `dist/cjs` js in the tarball, `exports["."]` is `{types, import, require}`, `publishConfig.tag` is `rc`, no `private`, no `workspace:` ranges, no `test/`, `legacy/`, or `node_modules/` entries |
| `git status --porcelain` after everything | 0 | empty; HEAD still `341c8fa87e` |

Aggregate SHA-256 of the sorted per-file `shasum -a 256` lines:
`bf694d9e56968a45f4776f52c04318435e20252a96acab740d591cfdfa96c4fb`
(`<consumers>/tarballs.sha256`). The digest differs from the superseded run's
`c602de1e...` because this pack is `341c8fa87e`. The per-package name and size
table is `<consumers>/tarball-table.md` (40 rows, all `1.0.0-rc.0`).

Wave-8 pack fixes, verified on the artifacts:

- `tar -tzf smthrs-1.0.0-rc.0.tgz` lists `package/dist/cjs/package.json`. At
  `cd14388ed7` the `smthrs` tarball was the only one without the CommonJS
  module-type marker.
- `tar -tzf smthrs-memory-1.0.0-rc.0.tgz` lists 3 `.sql` files
  (`src/migrations/0001_memory.sql`, `0002_memory_fts.sql`,
  `0003_memory_vectors.sql`).

## Fixtures

`<consumers>/make-fixture.mjs` writes each fixture's `package.json`:
`private: true`, `type: "module"`, and `dependencies` naming the 40 tarballs
as `file:../tarballs/<file>.tgz` plus the two registry dependencies the README
install line names, `effect@4.0.0-rc.108` and
`@effect/platform-node@4.0.0-rc.108` (42 dependencies). `--overrides` adds an
`overrides` map with the same 42 entries (Bun needs it before publication;
see below).

`quickstart.ts` is the README "Quick start" code block at `341c8fa87e`,
extracted with `awk` from the ` ```ts ` fence between `## Quick start` and
`## Examples`. The extraction is 38 lines, SHA-256 `fdc99f73...`,
byte-identical to the extraction of both superseded runs: the code block is
unchanged; polish-2 added the overrides prose above it.

`import-roots.mjs` imports the root entry of every packed package through the
fixture's `node_modules` and requires the unscoped `smthrs` notice to throw
`smthrs 1.0 is a migration notice, not a runtime.` on load (rc-contract
section 3.3). `count-effect.sh` lists every installed copy of `effect` and
`@effect/platform-node-shared` with its version.

### Node fixture (`<consumers>/node-consumer`)

Step 1, the README install line as written, no overrides:

| Command | Exit | Final lines |
| --- | --- | --- |
| `npm install --no-audit --no-fund` | 0 | `added 93 packages in 20s`; one `npm warn ERESOLVE overriding peer dependency` line; one `allow-scripts` warning for `msgpackr-extract@3.0.4` (blocked; nothing needed it). Log `npm-install.log` |
| `node quickstart.ts` (v24.18.0) | 0 | `Hello, Ada.` and nothing else. Log `node-quickstart.log` |
| `/Users/williamcory/.nvm/versions/node/v22.19.0/bin/node quickstart.ts` | 0 | `Hello, Ada.` Log `node22-quickstart.log` |
| `npm ls` | 0 | direct dependencies only; the invalid nested edge is below its depth (see Caveats). Log `npm-ls-no-overrides.log` |
| `npm ls --all` | 1 | `npm error invalid: effect@4.0.0-rc.108 ...` from the nested `@effect/platform-node-shared@4.0.0-rc.112`. Log `npm-ls-all-no-overrides.log` |
| `npm ls effect @effect/platform-node-shared` | 1 | `ELSPROBLEMS`, `invalid: effect@4.0.0-rc.108`. Log `npm-ls-named-no-overrides.log` |

Layout without the pin (`effect-count-no-overrides.log`): one `effect` at
`4.0.0-rc.108`; two `@effect/platform-node-shared` copies, `4.0.0-rc.108` at
the root and `4.0.0-rc.112` nested under `@effect/platform-node`. Same drift
as both superseded runs.

Step 2, the README overrides recipe, exactly as the README prints it for npm:

```json
{ "overrides": { "@effect/platform-node-shared": "4.0.0-rc.108" } }
```

The pin was added to `package.json`, then `node_modules` and
`package-lock.json` were removed and the install repeated (see Caveats for why
the clean reinstall is required):

| Command | Exit | Final lines |
| --- | --- | --- |
| `npm install --no-audit --no-fund` (clean, pin present) | 0 | `added 92 packages in 27s`; zero `ERESOLVE` lines. Log `npm-install-overrides.log` |
| `npm ls` | 0 | Log `npm-ls-overrides.log` |
| `npm ls --all` | 0 | Log `npm-ls-all-overrides.log` |
| `npm ls effect @effect/platform-node-shared` | 0 | tree ends `effect@4.0.0-rc.108`. Log `npm-ls-named-overrides.log` |
| `node quickstart.ts` (v24.18.0, then v22.19.0) | 0, 0 | `Hello, Ada.` both. Logs `node-quickstart-2.log`, `node22-quickstart-2.log` |
| `node import-roots.mjs ../tarballs/manifest.json` | 1 | `39 ok, 1 failed`: `@smthrs/platform-bun` needs its declared optional peer. Log `node-import-roots.log` |
| `npm install --save-exact --no-audit --no-fund @effect/platform-bun@4.0.0-rc.108` | 0 | Log `npm-install-peer.log` |
| `node import-roots.mjs ...` (after the peer) | 0 | `40 ok, 0 failed`. Log `node-import-roots-2.log` |
| `node --input-type=commonjs -e 'require("smthrs")'` | n/a | throws `smthrs 1.0 is a migration notice, not a runtime.` through the repacked `dist/cjs/package.json`. Log `cjs-notice.log` |
| `npm ls` after the peer add | 0 | the optional peer does not reopen the tree |

Layout with the pin (`effect-count-overrides.log`): exactly one `effect` at
`4.0.0-rc.108` and exactly one `@effect/platform-node-shared` at
`4.0.0-rc.108`. `node_modules` is 174 MB.

### Bun fixture (`<consumers>/bun-consumer`)

| Command | Exit | Final lines |
| --- | --- | --- |
| `bun install` (42 dependencies, no overrides at all) | 1 | 162 `error: @smthrs/<name>@1.0.0-rc.0 failed to resolve` lines beside `error: GET https://registry.npmjs.org/@smthrs%2fplatform-node - 404`. Log `bun-install-no-overrides.log` |
| rewrite with the 42-entry `overrides` map (no `@effect/platform-node-shared` pin), `bun install` | 0 | `93 packages installed [2.54s]`. Log `bun-install.log` |
| `bun quickstart.ts` | 0 | `Hello, Ada.` Log `bun-quickstart.log` |

Layout without the pin (`effect-count-no-pin.log`): one `effect` at
`4.0.0-rc.108`; six `@effect/platform-node-shared` copies, one hoisted at
`4.0.0-rc.112` and five nested at `4.0.0-rc.108` under
`@smthrs/{cli,gateway,migrate,platform-bun,platform-node}`. Same drift shape
as the superseded run. Bun has no `npm ls` equivalent that validates peer
ranges, so the recorded evidence for Bun is the installed layout itself.

Then the README recipe for Bun, the same `overrides` key: the pin
`"@effect/platform-node-shared": "4.0.0-rc.108"` was added to the map (43
entries), `node_modules` and `bun.lock` removed, and the install repeated:

| Command | Exit | Final lines |
| --- | --- | --- |
| `bun install` (pin present) | 0 | `92 packages installed [2.22s]`. Log `bun-install-pin.log` |
| `bun quickstart.ts` | 0 | `Hello, Ada.` Log `bun-quickstart-2.log` |
| `bun import-roots.mjs ../tarballs/manifest.json` | 1 | `39 ok, 1 failed`: `@smthrs/platform-bun`, `Cannot find module '@effect/platform-bun/BunChildProcessSpawner'`. Log `bun-import-roots.log` |
| `bun add --exact @effect/platform-bun@4.0.0-rc.108` | 0 | Log `bun-add-peer.log` |
| `bun import-roots.mjs ...` (after the peer) | 0 | `40 ok, 0 failed`. Log `bun-import-roots-2.log` |
| `bun quickstart.ts` (after the peer) | 0 | `Hello, Ada.` Log `bun-quickstart-3.log` |

Layout with the pin (`effect-count-pin.log`): exactly one `effect` at
`4.0.0-rc.108` and exactly one `@effect/platform-node-shared` at
`4.0.0-rc.108`. `node_modules` is 174 MB; `bun.lock` is 39,304 bytes.

The pre-publication overrides requirement is unchanged from both superseded
runs: Bun does not satisfy a nested exact `@smthrs/*@1.0.0-rc.0` edge from a
root `file:` tarball, it queries the registry where no `@smthrs/*` version
exists, and the install fails. After `1.0.0-rc.0` publishes, a Bun consumer
following the README install line resolves those edges from the registry and
needs only the one-line `@effect/platform-node-shared` pin.

The quick-start runs `FlowEngine.layerMemory`, so the Bun result stays inside
the rc-contract section 1 Bun claim (no durable flow under Bun).

## The scaffold, launched with no provider credential

New in this run; it validates the init-scaffold-launch lane against the
installed tarballs. The Phase 7 verdict at `cd14388ed7` had recorded the
launch answering `Run run-1 was accepted but the executor did not take it`
with a `control.db` row stranded `accepted` under owner pid 0.

Project: `<consumers>/node-consumer/hello-project/`, an empty directory with a
bare `.git/` (what an operator runs `smithers init` in). Binary:
`<consumers>/node-consumer/node_modules/.bin/smithers`, the `@smthrs/cli`
tarball's shim, which runs its published `dist/esm/bin.js`. Every command ran
under
`env -u SMITHERS_HOME -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u OPENROUTER_API_KEY -u CEREBRAS_API_KEY -u SMITHERS_OPENAI_AUTH -u FLOWS_OPENAI_AUTH`,
the six seat variables `packages/cli/test/Bin.test.ts` strips.

| Command | Exit | Result |
| --- | --- | --- |
| `smithers init hello --json` | 0 | receipt names `flows/hello/flow.mdx`, `"seat":"anthropic:claude-sonnet-4-5"`, `"gitignore":"created"`; the flow file carries `model: anthropic:claude-sonnet-4-5` and a comment naming `ANTHROPIC_API_KEY`; `.gitignore` gained `.flows/`. Log `init.log` |
| `smithers up hello --json` | 1 | stdout empty (0 bytes); stderr `LaunchFailed: Set ANTHROPIC_API_KEY to run the anthropic:claude-sonnet-4-5 seat`. Logs `up.log`, `up.err` |
| `smithers ps --json` | 0 | one item, `run-1`, `"status":"failed"`. Log `ps.log` |
| direct SQLite read of `.flows/control.db` | n/a | `flows_runs`: one row `run-1`, `status = failed`, `finished_at_ms` set; `COUNT(*) WHERE status = 'accepted'` is 0. Log `db-check.log` |
| direct SQLite read of `.flows/engine.db` | n/a | `flows_runs` holds 0 rows: the executor refused before the engine was handed anything. Log `db-check.log` |
| second `smithers up hello --json` | 1 | same refusal; the settled row is not re-driven; `flows_runs` then holds `run-1` and `run-2`, both `failed`. Logs `up2.err`, `db-check-2.log` |
| `smithers status run-1` | 0 | `Verdict   failed — Set ANTHROPIC_API_KEY to run the anthropic:claude-sonnet-4-5 seat`. Log `status.log` |

The task's requirement holds exactly: the launch exits 1 naming the missing
key and leaves no accepted run row behind.

## Repository smoke on the same tarballs

`env -u SMITHERS_HOME node scripts/smoke-release.mjs <consumers>/tarballs`
from `<clean-checkout-4>` exited 0 with 40 `smoke ok` lines and the final line
`release smoke holds: 40 tarballs install, import, and typecheck on node 24.18.0.`
(`<consumers>/smoke-release.log`). The script builds its own pnpm project
under `$TMPDIR`, overrides every `@smthrs/*` name to its tarball, installs the
optional peers, imports every packed entry as ESM, requires it as CJS, checks
the notice, and typechecks `smoke.mts` against the shipped declarations; it
removed its scratch directory itself (no `smthrs-release-smoke-*` remained).

## Caveats

### `@effect/platform-node-shared` drift, now documented, recipe verified

The drift reproduces at `341c8fa87e` exactly as recorded in both superseded
runs: `@effect/platform-node@4.0.0-rc.108` asks for `@effect/platform-node-shared`
`^4.0.0-rc.108`, the registry serves `4.0.0-rc.112`, and that version's peer
range demands Effect `^4.0.0-rc.112`. What changed since `cd14388ed7` is that
the README and `docs/pages/installation.md` now carry the overrides recipe
(polish-2, L2), and this run verified it end to end in both package managers:
with the pin, one `effect` and one `@effect/platform-node-shared`, both
`4.0.0-rc.108`, and every `npm ls` form exits 0. The superseded run's routing
request is closed.

Two precision notes for the docs owner, reported for the orchestrator to
route; neither was fixed in the clean checkout and neither affects the
verdict:

- The README sentence "`npm ls` exits 1 until you override the range" holds
  for the forms that walk the tree (`npm ls --all` exits 1, and so does
  `npm ls <name>` naming an affected package), but bare `npm ls` prints only
  direct dependencies and exits 0 with the drift in place (npm 11.16.0,
  `npm-ls-no-overrides.log`). The recipe's own claim is unaffected: with the
  pin, every form exits 0.
- npm 11.16.0 does not reconcile an existing tree when `overrides` is edited
  afterward: with `node_modules` and `package-lock.json` already on disk,
  `npm install` after adding the pin answered `up to date in 610ms` and left
  the nested `4.0.0-rc.112` copy in place. A consumer who adds the pin to an
  already-installed project must remove `package-lock.json` and
  `node_modules` and reinstall. A fresh consumer following the README top to
  bottom never sees this.

### Optional peer for `@smthrs/platform-bun`

Unchanged from the superseded runs. The one first-run `import-roots` failure
in each fixture is by design: `@smthrs/platform-bun` declares
`@effect/platform-bun@4.0.0-rc.108` as an optional peer, and both fixtures
reach `40 ok, 0 failed` once it is added. The quick-start never needs it.

### Install footprint

93 packages without the pin, 92 with it (the pin removes the duplicated
`@effect/platform-node-shared`). The superseded run's 93 matches; its
footprint analysis against `20b32c6316` still stands.

## Artifacts

All under `<consumers>`: `environment.txt`, `registry-check.log`,
`pack-order.txt`, `build-all.sh`, `build.log`, `build-logs/` (40 files),
`check-dist.{mjs,log}`, `pack.log`, `manifest.json`, `tarballs.sha256`,
`tarball-table.md`, `verify-tarballs.sh`, `tarball-verify.log`,
`make-fixture.mjs`, `import-roots.mjs`, `count-effect.sh`, `quickstart.ts`,
`smoke-release.log`, and the per-fixture logs named in the tables above inside
`node-consumer/` and `bun-consumer/` (including `hello-project/` with its
`.flows/{control,engine}.db` left in their settled state). Per the gate's disk
instruction, `<consumers>/tarballs/` and both fixtures' `node_modules/` were
removed after the verdict (`manifest.json` was kept beside the logs); the
lockfiles (`package-lock.json`, `bun.lock`) record what was installed.

The clean checkout is unchanged: `git status --porcelain` is empty at HEAD
`341c8fa87e` after the build, pack, fixtures, scaffold runs, and smoke.
Nothing was edited in `/Users/williamcory/smithers`, `/Users/williamcory/flows/flows`,
or `/Users/williamcory/plue`.

## Verdict

PASS. At `341c8fa87e` the 40 public packages pack from built artifacts,
install into fresh Node (npm 11.16.0) and Bun (1.4.0) fixtures from `file:`
tarballs, and run the README quick-start to `Hello, Ada.` with exit 0 under
Node 24.18.0, Node 22.19.0, and Bun 1.4.0. The README's
`@effect/platform-node-shared@4.0.0-rc.108` overrides recipe leaves one copy
of `effect` and one of the shared package in each fixture and makes every
`npm ls` form exit 0 (without it, `npm ls --all` and the named form exit 1).
`smithers init hello` scaffolds a launchable flow with a `model:` line, and
`smithers up hello` with the provider environment stripped exits 1 with
`Set ANTHROPIC_API_KEY to run the anthropic:claude-sonnet-4-5 seat`, settling
the run `failed` with zero accepted rows and zero engine rows.
