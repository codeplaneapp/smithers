# Phase 7 gate: browser-bundling

Verdict: PASS

All 28 advertised browser-safe entry points bundle under esbuild
`--platform=browser` from the clean checkout at `341c8fa87e`, all 7 documented
Node-only entry points fail only on their documented `node:` builtin, the
`pnpm run browser` route, the CI `//scripts:browserContract` route, and the
`scripts/check-docs.mjs` browser-table check all exit 0, the final line matches
the Phase 2 baseline verbatim, and the docs pages agree with the contract the
gate executes.

This file supersedes the 2026-08-31 04:59 PT evidence taken at `cd14388ed7`
from this same checkout. The superseded file is kept beside this one as
`browser-bundling-prev-cd14388ed7.md` with its logs in
`browser-bundling-logs-prev-cd14388ed7/`. The earlier run at `20b32c6316`
remains preserved as `browser-bundling-prev-20b32c6316.md`.

## Scope

PLAN.md Phase 7 requires "browser bundling for advertised browser-safe entry
points". `docs/migration/rc-contract.md` section 1 defines the advertised list:
28 `BROWSER_SAFE` entries must bundle and the 7 `NODE_ONLY` entries
(`@smthrs/platform-node`, `@smthrs/platform-bun`, `@smthrs/kernel/test/TestHost`,
`@smthrs/jj/node/NodeJj`, `@smthrs/jj/bun/BunJj`,
`@smthrs/database/node/NodeDatabase`, `@smthrs/flows/NodeRuntime`) must fail
only on their documented `node:` builtin. `docs/migration/phase2-baseline.md`
line 25 pins the expected result: `corepack pnpm run browser` exits 0 with
`browser contract holds: 28 browser entry points, 7 Node-only`. CI runs the
same script through the `browser` job
(`pnpm exec smithers-build test '//scripts:browserContract'`, target declared
at `scripts/PACKAGE.ts:122`).

New since the `cd14388ed7` run: commit `6f4f2bacf9` (landed through the wave-8
polish-2 merge `a42f8f6e5d`) moved the `BROWSER_SAFE` and `NODE_ONLY` lists out
of `scripts/browser-check.mjs` into `scripts/browser-contract.mjs`
(`git diff --stat cd14388ed7 341c8fa87e`: browser-check.mjs -88 lines,
browser-contract.mjs +122). `scripts/browser-check.mjs` imports both lists and
executes them with esbuild exactly as before (`bundle: true`, `write: false`,
`platform: "browser"`, `format: "esm"`, `target: "es2022"`; bundles stay in
memory, nothing is written). `scripts/check-docs.mjs` check 15 reads the same
declaration (`browserEntryNames`, `nodeEntryNames`, `citedBrowserCounts`) and
fails when `docs/pages/architecture/browser-support.md` tables list a
different set or when any page under `docs/` (plus `README.md`, excluding
`docs/dist` and `docs/migration/evidence`) states a different count. This gate
therefore runs check-docs as well, which the task requires to agree with
`docs/pages/architecture/browser-support.md` and
`docs/pages/package-structure.mdx`.

## Environment

| Item            | Value                                                                                                                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checkout        | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4`                                                                                                                         |
| HEAD            | `341c8fa87e2dadbe80d0f0d3258dae112a7d03d3` (`v1/rc0-migration`, `docs(release): consumer overrides note and the browser-contract list's new home`); `git status --porcelain` empty before and after the run; `vendor/jj` submodule clean at `47589ada70c` |
| Host            | macOS, Darwin 25.2.0, arm64; load averages 3.37 4.30 5.40 at start, 6.71 4.86 5.48 before check-docs (other Phase 7 gates share the machine and checkout)                                                                                                 |
| Date            | 2026-08-31 16:17:39 to 16:19:39 UTC (09:17 to 09:19 PT)                                                                                                                                                                                                   |
| Node            | v24.18.0 (rc-contract floor `>=22.19.0`; CI pins 22.19.0)                                                                                                                                                                                                 |
| corepack / pnpm | 0.35.0 / 11.21.0 (`packageManager: pnpm@11.21.0`)                                                                                                                                                                                                         |
| Bun             | 1.4.0 (not used by this gate)                                                                                                                                                                                                                             |
| esbuild         | 0.28.1 from the checkout's `node_modules` (root `devDependencies.esbuild: "0.28.1"`)                                                                                                                                                                      |
| Environment     | `SMITHERS_HOME` stripped with `env -u` on every command; `SMITHERS_CACHE_URL` and `SMITHERS_CACHE_TOKEN` also stripped for the build-CLI route so no remote cache could answer                                                                            |

Dependencies come from the setup step's frozen offline install at this HEAD
(`corepack pnpm install --frozen-lockfile --offline`, exit 0).

## Commands and results

Logs: `browser-bundling-logs/` next to this file. Each log starts with a
`start <UTC timestamp>` line and ends with an `exit=<code> duration=<seconds>s`
line appended by the harness.

| Command (from the checkout root)                                                                                               | Exit | Duration           | Final output line                                                                                   | Log                                       |
| ------------------------------------------------------------------------------------------------------------------------------ | ---- | ------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `env -u SMITHERS_HOME corepack pnpm run browser`                                                                               | 0    | 2 s                | `browser contract holds: 28 browser entry points, 7 Node-only.`                                     | `pnpm-run-browser.log`                    |
| `env -u SMITHERS_HOME -u SMITHERS_CACHE_URL -u SMITHERS_CACHE_TOKEN pnpm exec smithers-build test '//scripts:browserContract'` | 0    | 5 s (target 2.6 s) | `ok: true`; result row `"//scripts:browserContract",NodeTest,ran`                                   | `smithers-build-test-browserContract.log` |
| `env -u SMITHERS_HOME node scripts/check-docs.mjs`                                                                             | 0    | 77 s               | `✓ the browser tables and counts match the 28 entry points the gate bundles` (17 of 17 checks pass) | `check-docs.log`                          |
| `node browser-bundling-logs/extra-browser-bundle.mjs <checkout>` (ad hoc, see below)                                           | 0    | 0 s                | `esbuild 0.28.1; 3/3 bundled`                                                                       | `extra-doc-advertised-entries.log`        |

The `pnpm run browser` final line matches `docs/migration/phase2-baseline.md`
line 25 verbatim. `git status --porcelain` in the checkout is empty after
every command.

### Browser-safe entry points that bundled (28 of 28)

Sizes are the in-memory ESM bundle reported by the script. All 28 sizes are
byte-for-byte identical to the `cd14388ed7` run: `6f4f2bacf9` moved the list
declaration but changed no bundled source.

| Entry point                          | Source                                       | Bundle size |
| ------------------------------------ | -------------------------------------------- | ----------- |
| @smthrs/artifacts                    | packages/artifacts/src/index.ts              | 290.1 kB    |
| @smthrs/canonical                    | packages/canonical/src/index.ts              | 155.9 kB    |
| @smthrs/capability                   | packages/capability/src/index.ts             | 503.8 kB    |
| @smthrs/chain                        | packages/chain/src/index.ts                  | 1828.3 kB   |
| @smthrs/crypto                       | packages/crypto/src/index.ts                 | 156.8 kB    |
| @smthrs/jj                           | packages/jj/src/index.ts                     | 598.5 kB    |
| @smthrs/jj/browser/BrowserJj         | packages/jj/src/browser/BrowserJj.ts         | 525.8 kB    |
| @smthrs/platform-browser             | packages/platform-browser/src/index.ts       | 916.4 kB    |
| @smthrs/platform-browser/BrowserHost | packages/platform-browser/src/BrowserHost.ts | 915.6 kB    |
| @smthrs/sandbox                      | packages/sandbox/src/index.ts                | 269.3 kB    |
| @smthrs/kernel                       | packages/kernel/src/index.ts                 | 940.0 kB    |
| @smthrs/keys                         | packages/keys/src/index.ts                   | 160.9 kB    |
| @smthrs/plan                         | packages/plan/src/index.ts                   | 741.6 kB    |
| @smthrs/database                     | packages/database/src/index.ts               | 693.3 kB    |
| @smthrs/journal                      | packages/journal/src/index.ts                | 784.3 kB    |
| @smthrs/run-store                    | packages/run-store/src/index.ts              | 743.3 kB    |
| @smthrs/step-cache                   | packages/step-cache/src/index.ts             | 734.2 kB    |
| @smthrs/flow                         | packages/flow/src/index.ts                   | 416.1 kB    |
| @smthrs/engine                       | packages/engine/src/index.ts                 | 591.2 kB    |
| @smthrs/engine-store                 | packages/engine-store/src/index.ts           | 1462.8 kB   |
| @smthrs/flows                        | packages/flows/src/index.ts                  | 2103.6 kB   |
| @smthrs/observability                | packages/observability/src/index.ts          | 426.5 kB    |
| @smthrs/sync                         | packages/sync/src/index.ts                   | 423.5 kB    |
| @smthrs/time-travel                  | packages/time-travel/src/index.ts            | 841.1 kB    |
| @smthrs/std/Grep                     | packages/std/src/Grep.ts                     | 622.1 kB    |
| @smthrs/std/Glob                     | packages/std/src/Glob.ts                     | 615.1 kB    |
| @smthrs/std/Search                   | packages/std/src/Search.ts                   | 597.7 kB    |
| @smthrs/std/PortableSearch           | packages/std/src/PortableSearch.ts           | 629.5 kB    |

### Node-only entry points that failed on the documented builtin (7 of 7)

| Entry point                        | Documented builtin | Reason recorded by the gate                                                  |
| ---------------------------------- | ------------------ | ---------------------------------------------------------------------------- |
| @smthrs/platform-node              | node:child_process | the Node host bundle spawns child processes                                  |
| @smthrs/platform-bun               | node:fs            | the Bun bundle falls back to the @effect/platform-node adapters off Bun      |
| @smthrs/kernel/test/TestHost       | node:assert        | effect/testing's TestClock pulls node:assert                                 |
| @smthrs/jj/node/NodeJj             | node:child_process | the Node jj adapter spawns the jj CLI                                        |
| @smthrs/jj/bun/BunJj               | node:child_process | the Bun jj adapter reuses the Node child-process implementation              |
| @smthrs/database/node/NodeDatabase | node:sqlite        | the Node database layer is node:sqlite through @effect/sql-sqlite-node       |
| @smthrs/flows/NodeRuntime          | node:sqlite        | the supported production composition opens the database through NodeDatabase |

The script accepts a Node-only entry only when every esbuild error is an
unresolved `node:` builtin and one of them is the documented module, so each
row above is a real failure of the documented kind and nothing else.

## Docs agreement

The check-docs browser-table check (check 15, `scripts/check-docs.mjs:395-430`)
reads `BROWSER_SAFE` and `NODE_ONLY` from `scripts/browser-contract.mjs` and:

1. compares the "## Browser entry points" and "## Node entry points" tables in
   `docs/pages/architecture/browser-support.md` against the two lists in both
   directions (an omitted or extra entry fails the check);
2. reads every `docs/**/*.md{,x}` page plus `README.md` (excluding `docs/dist`
   and `docs/migration/evidence`) and fails any stated browser entry-point
   count that is not 28.

It passed: `✓ the browser tables and counts match the 28 entry points the gate
bundles`, the last of 17 passing checks, exit 0. Verified directly in the
sources as well: `docs/pages/architecture/browser-support.md` lists all 28
browser rows (the four `@smthrs/std` subpaths included) and all 7 Node rows,
and `docs/pages/package-structure.mdx:232` states "28 entry points bundle for
the browser, and 7 are documented Node-only."

## Coverage of the advertised list

The rc-contract section 3.1 package table (rows marked "gated yes", "subpath",
and the section 3.2 `@smthrs/chain` row "Stays in the browser gate") names 21
package roots, the `@smthrs/jj/browser/BrowserJj` subpath, and the four
`@smthrs/std` subpaths. The gate's 28 `BROWSER_SAFE` entries are exactly those
26 plus `@smthrs/platform-browser/BrowserHost` and `@smthrs/chain`. Every
contract row marked "gated Node-only" is one of the 7 `NODE_ONLY` entries. No
advertised entry is missing from the gate.

### Doc-advertised entries the script does not gate

The docs and the rc-contract advertise three more browser bundles outside
`BROWSER_SAFE`. Each was bundled ad hoc with the same esbuild options and the
checkout's esbuild 0.28.1 (`browser-bundling-logs/extra-browser-bundle.mjs`).
All three bundle, at the same sizes as at `cd14388ed7`:

| Advertised where                                                                                                                                    | Entry                                                             | Bundle size |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------- |
| `docs/pages/examples.md:28` (example 09, also covered by `examples/test/09-browser-use.test.ts`, which bundles the file with `platform: "browser"`) | examples/src/09-browser-use.ts                                    | 444.9 kB    |
| rc-contract line 162 named subpath                                                                                                                  | packages/platform-browser/src/BrowserChildProcessSpawner/index.ts | 124.5 kB    |
| rc-contract line 162 named subpath                                                                                                                  | packages/platform-browser/src/BrowserFileSystem/index.ts          | 846.3 kB    |

The `cd14388ed7` run's `@smthrs/patterns` and `@smthrs/core` rows are gone
from this list because `6f4f2bacf9` removed the ungated browser claim from
`docs/pages/api/patterns.md`; the page now states "Neither package has an
entry in the browser gate, so this page makes no claim about bundling it for a
browser", which satisfies rc-contract line 65.

## Observations from the previous run: all four closed

The `cd14388ed7` evidence recorded four prose surfaces that disagreed with the
measured contract. Commit `6f4f2bacf9` (wave-8 polish-2) closed every one, and
this run verified each fix:

1. `docs/pages/architecture/browser-support.md` now lists all 28 browser
   entries; the four `@smthrs/std` subpaths were added.
2. `docs/pages/package-structure.mdx:232` now states 28 entry points, not 23.
3. `examples/src/09-browser-use.ts:11-14` now states that `@smthrs/flows` and
   `@smthrs/engine-store` bundle for the browser and names
   `@smthrs/flows/NodeRuntime` as the Node-only subpath.
4. `docs/pages/api/patterns.md` no longer claims browser support for the
   ungated `@smthrs/patterns`.

The new check-docs check 15 pins all four so they cannot regress silently.

## Concurrent activity in the checkout

Other Phase 7 gate agents ran in the same checkout during and after this
window: `tsc` and vitest worker processes appeared from 09:20 PT, and the
git-ignored `docs/dist/` was rebuilt at 09:19:48 PT by another agent's docs
gate (this gate's `scripts/check-docs.mjs` does not write `docs/dist`, and all
three bundle commands use `write: false`). Workspace manifests' working-tree
`exports` maps point at `src/*.ts` and `node_modules/@smthrs/*` are symlinks
into `packages/*`, so esbuild resolves source files regardless of any `dist/`
directories other gates emit. Tracked files are unchanged
(`git status --porcelain` empty after every command). This gate created no
pack copies and no `docs/dist`; nothing needed removal.

## Verdict

PASS. Every advertised browser-safe entry point (all 28 declared in
`scripts/browser-contract.mjs`) bundles under esbuild `--platform=browser` at
`341c8fa87e`, every documented Node-only entry fails only on its documented
`node:` builtin, the script route, the CI target route, and the check-docs
browser-table check all exit 0, the final line matches the Phase 2 baseline
exactly, and `docs/pages/architecture/browser-support.md` and
`docs/pages/package-structure.mdx` agree with the executed contract.
