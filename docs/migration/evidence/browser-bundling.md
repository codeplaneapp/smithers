# Phase 7 gate: browser-bundling

Verdict: PASS

## Scope

PLAN.md Phase 7 requires "browser bundling for advertised browser-safe entry
points". The advertised list is defined by `docs/migration/rc-contract.md` §1:
the 28 `BROWSER_SAFE` entries in `scripts/browser-check.mjs` must bundle under
esbuild `--platform=browser`, and the 7 `NODE_ONLY` entries must fail only on
their documented `node:` builtin. The Phase 2 baseline
(`docs/migration/phase2-baseline.md`) pins the expected result:
`corepack pnpm run browser` exits 0 with
`browser contract holds: 28 browser entry points, 7 Node-only`.

## Environment

| Item | Value |
| --- | --- |
| Checkout | /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout |
| HEAD | `9c464343f0cfada6aa36f0a08144ed7cf1f0ce14` (`v1/rc0-migration`) |
| Node | v24.18.0 |
| pnpm (corepack, `packageManager: pnpm@11.21.0`) | 11.21.0 |
| Bun | 1.4.0 (not used by this gate) |
| esbuild (workspace toolchain) | 0.28.1 |
| Date | 2026-08-30 |

Dependencies were installed by the clean-install gate
(`00-clean-install.md`, `corepack pnpm install --frozen-lockfile`, exit 0).

## Command

Run from the clean checkout root:

```
corepack pnpm run browser        # runs: node scripts/browser-check.mjs
```

Exit code: 0.

## Result

All 28 advertised browser-safe entry points bundled (`browser ok`), each with
a real bundle produced in memory (`write: false`), and all 7 documented
Node-only entry points failed only on their documented `node:` builtin
(`node only`). Final output line:

```
browser contract holds: 28 browser entry points, 7 Node-only.
```

This matches the Phase 2 baseline exactly.

### Browser-safe entry points that bundled (28)

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
| @smthrs/engine-store | packages/engine-store/src/index.ts | 1458.7 kB |
| @smthrs/flows | packages/flows/src/index.ts | 2099.4 kB |
| @smthrs/observability | packages/observability/src/index.ts | 426.5 kB |
| @smthrs/sync | packages/sync/src/index.ts | 423.5 kB |
| @smthrs/time-travel | packages/time-travel/src/index.ts | 841.1 kB |
| @smthrs/std/Grep | packages/std/src/Grep.ts | 622.1 kB |
| @smthrs/std/Glob | packages/std/src/Glob.ts | 615.1 kB |
| @smthrs/std/Search | packages/std/src/Search.ts | 597.7 kB |
| @smthrs/std/PortableSearch | packages/std/src/PortableSearch.ts | 629.5 kB |

### Node-only entry points that failed on the documented builtin (7)

| Entry point | Documented builtin | Reason recorded by the gate |
| --- | --- | --- |
| @smthrs/platform-node | node:child_process | the Node host bundle spawns child processes |
| @smthrs/platform-bun | node:fs | the Bun bundle falls back to the @effect/platform-node adapters off Bun |
| @smthrs/kernel/test/TestHost | node:assert | effect/testing's TestClock pulls node:assert |
| @smthrs/jj/node/NodeJj | node:child_process | the Node jj adapter spawns the jj CLI |
| @smthrs/jj/bun/BunJj | node:child_process | the Bun jj adapter reuses the Node child-process implementation |
| @smthrs/database/node/NodeDatabase | node:sqlite | the Node database layer is node:sqlite through @effect/sql-sqlite-node |
| @smthrs/flows/NodeRuntime | node:sqlite | the supported production composition opens the database through NodeDatabase |

The Node-only set matches the 7 entries `rc-contract.md` §1 names verbatim.

## Post-run hygiene

`git status --porcelain` in the clean checkout is empty after the run. The
script bundles in memory (`write: false`), so no artifacts were written.

## Verdict

PASS. Every advertised browser-safe entry point (all 28 in the contract list)
bundles under esbuild `--platform=browser` at `9c464343f0`, every documented
Node-only entry fails only on its documented `node:` builtin, the script exits
0, and the final line matches the Phase 2 baseline.
