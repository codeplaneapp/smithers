# Phase 7 gate: browser-bundling

Verdict: PASS

All 28 advertised browser-safe entry points bundle under esbuild
`--platform=browser` from the clean checkout at `20b32c6316`, all 7 documented
Node-only entry points fail only on their documented `node:` builtin, both the
`pnpm run browser` script route and the CI `//scripts:browserContract` target
route exit 0, and the final line matches the Phase 2 baseline verbatim.

This file supersedes the evidence taken at `9c464343f0` in
`migration/clean-checkout` (that directory no longer exists).

## Scope

PLAN.md Phase 7 requires "browser bundling for advertised browser-safe entry
points". `docs/migration/rc-contract.md` §1 defines the advertised list: the
28 `BROWSER_SAFE` entries in `scripts/browser-check.mjs` must bundle, and the 7
`NODE_ONLY` entries (`@smthrs/platform-node`, `@smthrs/platform-bun`,
`@smthrs/kernel/test/TestHost`, `@smthrs/jj/node/NodeJj`, `@smthrs/jj/bun/BunJj`,
`@smthrs/database/node/NodeDatabase`, `@smthrs/flows/NodeRuntime`) must fail
only on their documented `node:` builtin. `docs/migration/phase2-baseline.md`
line 25 pins the expected result: `corepack pnpm run browser` exits 0 with
`browser contract holds: 28 browser entry points, 7 Node-only`. CI runs the
same script through the `browser` job (`.github/workflows/ci.yml:234-251`,
`pnpm exec smithers-build test '//scripts:browserContract'`, target declared at
`scripts/BUILD.ts:122`).

The script bundles each entry with esbuild (`bundle: true`, `write: false`,
`platform: "browser"`, `format: "esm"`, `target: "es2022"`). A bundle is
produced in memory and its byte size is reported; nothing is mocked and no
files are written.

## Environment

| Item | Value |
| --- | --- |
| Checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-2` |
| HEAD | `20b32c6316487497301db74ec70cbe951428ef53` (`v1/rc0-migration`), `git status --porcelain` empty before the run |
| Host | macOS 26.2 (25C56), Darwin 25.2.0, arm64 |
| Date | 2026-08-31 06:57 to 06:59 UTC (2026-08-30 23:57 to 23:59 PT) |
| Node | v24.18.0 (rc-contract floor `>=22.19.0`; CI pins 22.19.0) |
| corepack / pnpm | 0.35.0 / 11.21.0 (`packageManager: pnpm@11.21.0`) |
| Bun | 1.4.0 (not used by this gate) |
| esbuild | 0.28.1 (`node_modules/esbuild`, installed by the clean-install gate) |
| Environment | `SMITHERS_HOME` unset; `SMITHERS_CACHE_URL` and `SMITHERS_CACHE_TOKEN` unset for the build-CLI route so no remote cache could answer |

Dependencies were installed by the clean-install gate (`00-clean-install.md`,
`corepack pnpm install --frozen-lockfile`, exit 0).

## Commands and results

Logs: `browser-bundling-logs/` next to this file.

| Command (from the checkout root) | Exit | Duration | Final output line | Log |
| --- | --- | --- | --- | --- |
| `env -u SMITHERS_HOME corepack pnpm run browser` | 0 | 2 s | `browser contract holds: 28 browser entry points, 7 Node-only.` | `pnpm-run-browser.log` |
| `env -u SMITHERS_HOME -u SMITHERS_CACHE_URL -u SMITHERS_CACHE_TOKEN pnpm exec smithers-build test '//scripts:browserContract'` | 0 | 11 s (target 4.2 s) | `1 targets: 0 hit, 1 ran, 0 failed, 0 skipped (4.2s)`; `ok: true`; result row `"//scripts:browserContract",NodeTest,ran` | `smithers-build-test-browserContract.log` |
| `node browser-bundling-logs/extra-browser-bundle.mjs <checkout>` (ad hoc, see below) | 0 | 3 s | `esbuild 0.28.1; 5/5 bundled` | `extra-doc-advertised-entries.log` |

`git status --porcelain` in the checkout is empty after every command.

### Browser-safe entry points that bundled (28 of 28)

Sizes are the in-memory ESM bundle reported by the script.

| Entry point | Source | Bundle size |
| --- | --- | --- |
| @smthrs/artifacts | packages/artifacts/src/index.ts | 290.1 kB |
| @smthrs/canonical | packages/canonical/src/index.ts | 155.9 kB |
| @smthrs/capability | packages/capability/src/index.ts | 503.8 kB |
| @smthrs/chain | packages/chain/src/index.ts | 1828.3 kB |
| @smthrs/crypto | packages/crypto/src/index.ts | 156.8 kB |
| @smthrs/jj | packages/jj/src/index.ts | 598.5 kB |
| @smthrs/jj/browser/BrowserJj | packages/jj/src/browser/BrowserJj.ts | 525.8 kB |
| @smthrs/platform-browser | packages/platform-browser/src/index.ts | 916.4 kB |
| @smthrs/platform-browser/BrowserHost | packages/platform-browser/src/BrowserHost.ts | 915.6 kB |
| @smthrs/sandbox | packages/sandbox/src/index.ts | 269.3 kB |
| @smthrs/kernel | packages/kernel/src/index.ts | 940.0 kB |
| @smthrs/keys | packages/keys/src/index.ts | 160.9 kB |
| @smthrs/plan | packages/plan/src/index.ts | 741.6 kB |
| @smthrs/database | packages/database/src/index.ts | 693.3 kB |
| @smthrs/journal | packages/journal/src/index.ts | 784.3 kB |
| @smthrs/run-store | packages/run-store/src/index.ts | 743.3 kB |
| @smthrs/step-cache | packages/step-cache/src/index.ts | 734.2 kB |
| @smthrs/flow | packages/flow/src/index.ts | 416.1 kB |
| @smthrs/engine | packages/engine/src/index.ts | 591.2 kB |
| @smthrs/engine-store | packages/engine-store/src/index.ts | 1459.6 kB |
| @smthrs/flows | packages/flows/src/index.ts | 2100.3 kB |
| @smthrs/observability | packages/observability/src/index.ts | 426.5 kB |
| @smthrs/sync | packages/sync/src/index.ts | 423.5 kB |
| @smthrs/time-travel | packages/time-travel/src/index.ts | 841.1 kB |
| @smthrs/std/Grep | packages/std/src/Grep.ts | 622.1 kB |
| @smthrs/std/Glob | packages/std/src/Glob.ts | 615.1 kB |
| @smthrs/std/Search | packages/std/src/Search.ts | 597.7 kB |
| @smthrs/std/PortableSearch | packages/std/src/PortableSearch.ts | 629.5 kB |

Compared with the superseded `9c464343f0` run, `@smthrs/engine-store` grew
from 1458.7 kB to 1459.6 kB and `@smthrs/flows` from 2099.4 kB to 2100.3 kB;
the other 26 sizes are unchanged.

### Node-only entry points that failed on the documented builtin (7 of 7)

| Entry point | Documented builtin | Reason recorded by the gate |
| --- | --- | --- |
| @smthrs/platform-node | node:child_process | the Node host bundle spawns child processes |
| @smthrs/platform-bun | node:fs | the Bun bundle falls back to the @effect/platform-node adapters off Bun |
| @smthrs/kernel/test/TestHost | node:assert | effect/testing's TestClock pulls node:assert |
| @smthrs/jj/node/NodeJj | node:child_process | the Node jj adapter spawns the jj CLI |
| @smthrs/jj/bun/BunJj | node:child_process | the Bun jj adapter reuses the Node child-process implementation |
| @smthrs/database/node/NodeDatabase | node:sqlite | the Node database layer is node:sqlite through @effect/sql-sqlite-node |
| @smthrs/flows/NodeRuntime | node:sqlite | the supported production composition opens the database through NodeDatabase |

The script accepts a Node-only entry only when every esbuild error is an
unresolved `node:` builtin and one of them is the documented module, so each
row above is a real failure of the documented kind and nothing else.

## Coverage of the advertised list

The rc-contract §1 package table (rows marked "gated yes", "subpath", and the
`@smthrs/chain` row "Stays in the browser gate") names 21 package roots, the
`@smthrs/jj/browser/BrowserJj` subpath, and the four `@smthrs/std` subpaths.
The gate's 28 `BROWSER_SAFE` entries are exactly those 26 plus
`@smthrs/platform-browser/BrowserHost` and `@smthrs/chain`. Every contract row
marked "gated Node-only" is one of the 7 `NODE_ONLY` entries. No advertised
entry is missing from the gate.

### Doc-advertised entries the script does not gate

The docs advertise five more browser bundles outside `BROWSER_SAFE`. Each was
bundled ad hoc with the same esbuild options and the checkout's esbuild 0.28.1
(`browser-bundling-logs/extra-browser-bundle.mjs`). All five bundle:

| Advertised where | Entry | Bundle size |
| --- | --- | --- |
| `docs/pages/examples.md:28` (example 09, also covered by `examples/test/09-browser-use.test.ts`, PASS in `examples.md`) | examples/src/09-browser-use.ts | 444.9 kB |
| `docs/pages/api/patterns.md:9` ("every export here is browser safe"; contract row: no claim) | packages/patterns/src/index.ts | 311.5 kB |
| dependency of the row above (contract row: no claim) | packages/core/src/index.ts | 761.7 kB |
| rc-contract §162 named subpath | packages/platform-browser/src/BrowserChildProcessSpawner/index.ts | 124.5 kB |
| rc-contract §162 named subpath | packages/platform-browser/src/BrowserFileSystem/index.ts | 846.3 kB |

## Observations for the docs lane (not gate failures)

The measured contract is correct; four prose surfaces disagree with it.

1. `docs/pages/architecture/browser-support.md` "Browser entry points" table
   lists 24 rows. It omits `@smthrs/std/Grep`, `@smthrs/std/Glob`,
   `@smthrs/std/Search`, and `@smthrs/std/PortableSearch`, which the gate
   bundles and the contract table marks "subpath".
2. `docs/pages/package-structure.mdx:229` states "Twenty-three entry points
   bundle for the browser." The gate bundles 28.
3. `examples/src/09-browser-use.ts:11-12` header comment states "The barrel
   `@smthrs/flows` and `@smthrs/engine-store` are Node entry points". Both are
   `BROWSER_SAFE` and bundled in this run (2100.3 kB and 1459.6 kB).
4. `docs/pages/api/patterns.md:9` claims `@smthrs/patterns` is browser safe.
   rc-contract §1 line 65 says a "no claim" package's docs must not claim
   browser support until a gate entry exists. The claim is true in measurement
   (311.5 kB bundle) but ungated; either add `@smthrs/patterns` (and
   `@smthrs/core`) to `BROWSER_SAFE` and the contract table, or remove the
   sentence.

## Verdict

PASS. Every advertised browser-safe entry point (all 28 in the contract list)
bundles under esbuild `--platform=browser` at `20b32c6316`, every documented
Node-only entry fails only on its documented `node:` builtin, both the script
route and the CI target route exit 0, the final line matches the Phase 2
baseline exactly, and the checkout is unchanged after the run.
