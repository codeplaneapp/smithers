# Phase 7 gate: consumer-fixtures

Verdict: PASS

## Environment

| Item | Value |
| --- | --- |
| Host | macOS (Darwin 25.2.0), arm64 |
| Node | v24.18.0 |
| npm | 11.16.0 |
| Bun | 1.4.0 (`bun --version`; canary build 1.4.0-canary.1+6618e7f7e per the clean-install gate) |
| pnpm (corepack, `packageManager: pnpm@11.21.0`) | 11.21.0 |
| Clean checkout | /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout at `9c464343f0cfada6aa36f0a08144ed7cf1f0ce14` (`v1/rc0-migration`) |
| Date | 2026-08-30 |

## Build and pack

Packing requires built `dist/esm` and `dist/cjs` artifacts (`assertBuilt` in `scripts/pack-release.mjs`), so the 40 public packages were built first, in the publication order `node scripts/pack-release.mjs --list` prints. All commands ran from the clean checkout root.

| Command | Exit | Result |
| --- | --- | --- |
| `for d in $(node scripts/pack-release.mjs --list); do corepack pnpm --dir packages/$d run build; done` | 0 | 40 of 40 builds succeeded (`ALL_BUILDS_OK`); log at `phase7/consumers/build.log` |
| `node scripts/pack-release.mjs <S>/phase7/consumers/tarballs` | 0 | 40 tarballs plus `manifest.json`, 9.2 MB total; every entry is `<name>@1.0.0-rc.0` |
| `git status --short` afterwards | 0 | empty; building and packing left the checkout byte-identical (dist/ is gitignored, pack stages copies in a temp dir) |

The pack step rewrites each staged manifest's `exports` to `publishConfig.exports`, so the fixtures resolve the built `dist/esm` and `dist/cjs` artifacts, not workspace sources. Verified in the Node fixture: `require('@smthrs/flow/package.json').exports['.']` is `{ types: './dist/esm/index.d.ts', import: './dist/esm/index.js', require: './dist/cjs/index.js' }`, and `import.meta.resolve('@smthrs/flow')` lands on `node_modules/@smthrs/flow/dist/esm/index.js`.

## Fixtures

Both fixtures live under `phase7/consumers/`, each with a fresh `package.json` (`private: true`, `type: "module"`) whose dependencies are the 40 packed tarballs as `file:../tarballs/<file>.tgz` plus the two registry dependencies the README quick-start names: `effect@4.0.0-rc.108` and `@effect/platform-node@4.0.0-rc.108`. `quickstart.ts` is the README "Quick start" code block, extracted verbatim from `README.md` (the block between the `## Quick start` and `## Examples` headings).

### Node fixture (`phase7/consumers/node-consumer`)

| Command | Exit | Final lines |
| --- | --- | --- |
| `npm install --no-audit --no-fund` | 0 | `added 136 packages in 28s` (one allow-scripts warning for `msgpackr-extract@3.0.4`; scripts stayed blocked and nothing needed them) |
| `node quickstart.ts` | 0 | `Hello, Ada.` |

npm satisfied every nested exact `@smthrs/*@1.0.0-rc.0` edge from the root `file:` installs with no overrides: `npm ls` shows all 40 packages `deduped` against the root copies, and exactly one `effect` directory exists on disk, at `4.0.0-rc.108`.

### Bun fixture (`phase7/consumers/bun-consumer`)

| Command | Exit | Final lines |
| --- | --- | --- |
| `bun install` (dependencies only, first attempt) | 1 | `error: @smthrs/<name>@1.0.0-rc.0 failed to resolve` for the transitive edges; see the caveat below |
| `bun install` (with `overrides`) | 0 | `137 packages installed [2.28s]` |
| `bun quickstart.ts` | 0 | `Hello, Ada.` |

Unlike npm, Bun does not satisfy a nested exact `@smthrs/*@1.0.0-rc.0` edge from a root `file:` tarball; it goes to the registry, where `1.0.0-rc.0` is not published, and the install fails. The Bun fixture therefore adds npm-style `overrides` mapping each of the 40 names to its tarball, the same technique `scripts/smoke-release.mjs` already uses for pnpm (`pnpm-workspace.yaml` overrides) and for the same reason. This is a pre-publication fixture requirement, not a product defect: once `1.0.0-rc.0` is on the registry, a Bun consumer running the README `pnpm add`/`bun add` line resolves the transitive edges normally. Exactly one `effect` directory exists on disk, at `4.0.0-rc.108`.

The quick-start runs the in-memory engine, which keeps this inside the rc-contract Bun support claim (section 1: no durable flow under Bun; the `flow` and `engine` suites are in the Bun CI matrix).

## Caveat: `@effect/platform-node-shared` drift on the registry

`@effect/platform-node@4.0.0-rc.108` declares `@effect/platform-node-shared: ^4.0.0-rc.108`. The registry now serves `4.0.0-rc.112` for that range, and that version wants `effect@^4.0.0-rc.112`. Consequences in the fixtures:

- Both fixtures still hold exactly one `effect` at `4.0.0-rc.108` (the README's stated single-instance requirement holds), but a `@effect/platform-node-shared@4.0.0-rc.112` copy is installed beside the `4.0.0-rc.108` copies the `@smthrs` packages pin (npm: 2 copies, bun: 6 copies).
- `npm ls effect ...` exits nonzero with `ELSPROBLEMS: invalid: effect@4.0.0-rc.108`, because rc.112's `effect@^4.0.0-rc.112` peer range is unsatisfied. The install itself and the quick-start are unaffected.

The workspace's own lockfiles pin `@effect/platform-node-shared@4.0.0-rc.108`, so the repository never sees this; only a fresh consumer following the README install line does. The quick-start does not exercise the drifted module, so this gate passes, but a consumer note (pin `@effect/platform-node-shared@4.0.0-rc.108` via overrides until Effect rc lines stop floating) is worth considering for the release notes. Reported for the orchestrator to route; no fix was made in the clean checkout.

## Artifacts

- `phase7/consumers/build.log`, `phase7/consumers/pack.log` (empty on success), `phase7/consumers/tarballs/` (40 `.tgz` + `manifest.json`)
- `phase7/consumers/node-consumer/{package.json,quickstart.ts,npm-install.log,node-quickstart.log,npm-ls.log}`
- `phase7/consumers/bun-consumer/{package.json,quickstart.ts,bun-install.log,bun-quickstart.log}`
- `phase7/consumers-quickstart.ts` (the verbatim README extraction both fixtures copy)

## Verdict

PASS. All 40 public packages pack from built artifacts, install into fresh Node (npm 11.16.0) and Bun (1.4.0) consumer fixtures from `file:` tarballs, resolve through their published `dist` exports, and the README quick-start prints `Hello, Ada.` with exit 0 in both runtimes with a single `effect@4.0.0-rc.108` instance each.
