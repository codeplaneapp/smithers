# Phase 7 fix lane: polish-2

Branch `phase7/polish-2`, based on `v1/rc0-migration` at `f63809382b`.
Worktree `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/wt/polish-2`.
Commits `6f4f2bacf9` (the four findings) and `3a835a8a60` (a stale script name the
first commit created).

All four low findings from `verdict-cd14388ed7.md` are closed, each with a pin in
a gate the pipeline already runs. Neither lockfile changed: no manifest
dependency moved.

Environment: macOS 26.2 arm64, Node v24.18.0, pnpm 11.21.0 via corepack, Bun
1.4.0, npm 11.16.0. Install: `corepack pnpm install --frozen-lockfile --offline`,
exit 0.

## L1. The three live commands in `packages/integrations/README.md`

Source, `packages/integrations/README.md:155-157` before the fix:

```
GITHUB_TOKEN=…  pnpm --filter @smthrs/integrations exec vitest run test/GitHubLive.test.ts
LINEAR_API_KEY=…  pnpm --filter @smthrs/integrations exec vitest run test/LinearLive.test.ts
TELEGRAM_BOT_TOKEN=…  pnpm --filter @smthrs/integrations exec vitest run test/TelegramLive.test.ts
```

Reproduced as written, with a real GitHub token from `gh auth token`: the four
tests pass and the run exits 1 on the package-wide thresholds in
`packages/integrations/vitest.config.ts`.

```
Coverage summary
Statements   : 6.29% ( 90/1430 )
ERROR: Coverage for lines (6.53%) does not meet global threshold (99%)
[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command failed with exit code 1: vitest run test/GitHubLive.test.ts
```

Test: `packages/integrations/test/ReadmeCommands.test.ts`, `README live-suite
commands > runs each single-file command with coverage disabled`.

Red against the pre-fix README:

```
AssertionError: expected 'GITHUB_TOKEN=…  pnpm --filter @smthrs…' to contain '--coverage.enabled=false'
Expected: "--coverage.enabled=false"
Received: "GITHUB_TOKEN=…  pnpm --filter @smthrs/integrations exec vitest run test/GitHubLive.test.ts"
 ❯ test/ReadmeCommands.test.ts:31:23
```

Fix: `packages/integrations/README.md:155-157` append `--coverage.enabled=false`,
plus a paragraph naming the whole-suite command that measures coverage. Green:
`Test Files 1 passed (1)`, `Tests 2 passed (2)`.

Each fixed command proven live (load 3.4):

| Command                                           | Exit | Result                                            |
| ------------------------------------------------- | ---- | ------------------------------------------------- |
| GitHub, token from `gh auth token`                | 0    | `Tests 4 passed (4)`, 1.89 s                      |
| Linear, ambient `LINEAR_API_KEY`                  | 0    | `Tests 4 passed (4)`, 1.27 s                      |
| Telegram, both token names stripped with `env -u` | 0    | `Test Files 1 skipped (1)`, `Tests 3 skipped (3)` |

Telegram stays ENV-SKIP: `TELEGRAM_BOT_TOKEN` and `SMITHERS_TELEGRAM_BOT_TOKEN`
are unset on this host (the gate's own sweep of the environment, the macOS
keychain, and the shell profiles is recorded in `integrations-real-backend.md`),
and the rc-contract does not name Telegram an rc.0 release-smoke integration.

## L2. The peer drift a fresh consumer inherits

Reproduced without any `@smthrs` tarball, against the live registry, in a
two-dependency npm project (`effect@4.0.0-rc.108`,
`@effect/platform-node@4.0.0-rc.108`):

```
├─┬ @effect/platform-node@4.0.0-rc.108
│ ├─┬ @effect/platform-node-shared@4.0.0-rc.112
│ │ └── effect@4.0.0-rc.108 deduped invalid: "^4.0.0-rc.112" from node_modules/@effect/platform-node/node_modules/@effect/platform-node-shared
npm error code ELSPROBLEMS
```

`npm ls` exit 1 without the recipe, exit 0 with it, and the tree then holds one
`@effect/platform-node-shared@4.0.0-rc.108 overridden`. Bun applies the same
`overrides` field (installed copy 4.0.0-rc.108). pnpm does not: under the pinned
pnpm 11.21.0 a `pnpm.overrides` block in `package.json` is ignored,

```
[WARN] The "pnpm" field in package.json is no longer read by pnpm. The following keys were ignored: "pnpm.overrides".
node_modules/.pnpm/@effect+platform-node-shared@4.0.0-rc.112_effect@4.0.0-rc.108
```

and the pin has to live in `pnpm-workspace.yaml`, which resolves
`@effect+platform-node-shared@4.0.0-rc.108`. The documented recipe carries both
forms for that reason.

Test: `scripts/pack-release.test.mjs`, `the install docs pin the drifted
@effect/platform-node-shared to the packed effect version`.

Red against the pre-fix documents:

```
AssertionError [ERR_ASSERTION]: README.md must document the overrides pin
    expected: /"@effect\/platform-node-shared":\s*"4\.0\.0-rc\.108"/,
    operator: 'match',
```

Fix: `README.md` quick-start paragraph and a new "Override the drifted peer"
section in `docs/pages/installation.md`. The test reads the pin version from the
packed manifests rather than restating it, so bumping Effect moves the doc too.

Release artifacts are the orchestrator's. The sentence to add to
`docs/releases/1.0.0-rc.0.md` and `CHANGELOG.md`:

> Pin `@effect/platform-node-shared` to `4.0.0-rc.108` in your project's
> `overrides` (in `pnpm-workspace.yaml` for pnpm 11). The registry serves
> `4.0.0-rc.112` for the range `@effect/platform-node@4.0.0-rc.108` declares,
> and that version peers on Effect `4.0.0-rc.112`, so without the pin `npm ls`
> exits 1 even though the install runs on a single Effect copy.

No cell was added to `scripts/check-npm-dedupe.mjs`: that gate builds its fixture
from the packed manifests and asserts singleton copies, and the drift is in a
transitive `@effect/*` range no `@smthrs` manifest names. Asserting `npm ls`
exit 0 there would gate the registry's answer for a third-party range, which is
a flake, not a contract. The pin above holds the documented remedy instead.

## L3. Two packed-manifest inconsistencies

Both confirmed at the source. `packages/smthrs-deprecation/package.json` `files`
listed four `dist/**` globs and no `package.json` entry, so the
`{"type":"commonjs"}` marker `scripts/build.mjs` writes was dropped;
`packages/memory/package.json` packed `src/**/*.ts` only, while
`packages/memory/src/internal/Sql.ts:62` tells a reader "The statements mirror
`src/migrations/*.sql`".

Evidence for the memory decision: nothing in `packages/memory/src` reads a file
(`grep -rn "readFile\|import.meta.url\|fs\." packages/memory/src` finds nothing),
so `Sql.migrate` is canonical and the three `.sql` files are reference copies.
The package ships its own source, and the shipped source cites those files, so
they ship with it rather than being documented away.

Tests: `scripts/pack-release.test.mjs`, `every published manifest packs the
module-type marker its build writes`, `@smthrs/memory packs the SQL reference
copies its shipped source cites`, and `packsPath reads npm files globs the way
npm packs them`.

Red against the pre-fix manifests:

```
AssertionError [ERR_ASSERTION]: these manifests do not pack dist/cjs/package.json
    actual: [ 'smthrs-deprecation' ],
    expected: [],
AssertionError [ERR_ASSERTION]: @smthrs/memory files must pack 3 reference migrations
```

The first assertion matches the packed path, not one spelling of a glob:
`canonical` and `observability` pack the marker through `dist/**/*` and are not
offenders. A literal `files.includes("dist/**/package.json")` reported them, so
the test carries a small npm-glob reader with its own case list.

Fix: `packages/smthrs-deprecation/package.json` gains `"dist/**/package.json"`,
`packages/memory/package.json` gains `"src/**/*.sql"`. Proven on the artifact,
not only the manifest:

```
$ npm pack --dry-run --json --ignore-scripts   # packages/smthrs-deprecation, after build
files: 12
dist/cjs/package.json
$ npm pack --dry-run --json --ignore-scripts   # packages/memory
src/migrations/0001_memory.sql
src/migrations/0002_memory_fts.sql
src/migrations/0003_memory_vectors.sql
```

## L4. Documentation against the measured browser contract

`pnpm run browser` at this commit prints `browser contract holds: 28 browser
entry points, 7 Node-only.` Four prose surfaces disagreed.

The two lists moved from `scripts/browser-check.mjs` into a new
`scripts/browser-contract.mjs`, which the executing gate imports and the
documentation gate now reads. `scripts/check-docs.mjs` gains check 15, "the
browser tables and counts match the N entry points the gate bundles".

Red against the pre-fix documents, both halves:

```
✗ the browser prose disagrees with the contract the gate executes:
    browser-support.md: ## Browser entry points omits @smthrs/std/Grep
    browser-support.md: ## Browser entry points omits @smthrs/std/Glob
    browser-support.md: ## Browser entry points omits @smthrs/std/Search
    browser-support.md: ## Browser entry points omits @smthrs/std/PortableSearch
```

```
✗ the browser prose disagrees with the contract the gate executes:
    docs/pages/package-structure.mdx: states 23 browser entry points, the gate bundles 28
```

The count half is red only once the stale claim is written as a numeral: the
pre-fix sentence spelled it "Twenty-three", which the parser does not read, by
the same convention `citedPackageCounts` follows for the published-package count.
The red above was taken by transcribing the stale claim to `23` on top of the
pre-fix table, then restoring it; the fixed sentence states `28`.

Fixes:

- `docs/pages/architecture/browser-support.md`: four `@smthrs/std` rows added to
  the browser table (24 rows to 28).
- `docs/pages/package-structure.mdx`: five rows added to the entry-point matrix
  (`@smthrs/chain` and the four `@smthrs/std` subpaths, which is exactly the gap
  between its 23 "yes" rows and the measured 28), the sentence now reads "28
  entry points bundle for the browser, and 7 are documented Node-only", and the
  summary sentence names the chain contracts and the std subpaths.
- `examples/src/09-browser-use.ts:11-14`: the header no longer calls
  `@smthrs/flows` and `@smthrs/engine-store` Node entry points. Both are in
  `BROWSER_SAFE`; the Node-only entry is the `@smthrs/flows/NodeRuntime` subpath.
- `docs/pages/api/patterns.md:9`: the browser-safety claim is dropped.

`@smthrs/patterns` and `@smthrs/core` were not added to `BROWSER_SAFE`. Both
bundle, but the list is frozen at 28 by `rc-contract.md` section 1 and by
`phase2-baseline.md` line 25, which pins the gate's output line verbatim.
Promoting them is a contract edit this lane does not own, so the ungated claim
was removed instead, which is what `rc-contract.md` line 65 requires. Recommend
the promotion as a separate contract decision: it costs two list entries, two
table rows, and the three pinned counts.

## Gates

Load from `uptime` immediately before each block.

| Gate                                                                     |  Load | Result                                                                                                                               |
| ------------------------------------------------------------------------ | ----: | ------------------------------------------------------------------------------------------------------------------------------------ |
| `corepack pnpm install --frozen-lockfile --offline`                      | 11.85 | exit 0                                                                                                                               |
| `pnpm run browser`                                                       |  3.15 | exit 0, `browser contract holds: 28 browser entry points, 7 Node-only.`                                                              |
| `node scripts/check-docs.mjs`                                            |  4.08 | exit 0, 15 checks, `the browser tables and counts match the 28 entry points the gate bundles`                                        |
| `node scripts/check-llms.mjs`                                            |  4.08 | exit 0, `12 documentation artifact(s) are current`                                                                                   |
| `node --test scripts/pack-release.test.mjs`                              |  4.08 | `tests 16, pass 16, fail 0`                                                                                                          |
| `node --test scripts/repo-contract/*.test.mjs`                           |  4.08 | `tests 27, pass 27, fail 0`                                                                                                          |
| `node --test` over the seven docs unit suites                            |  4.08 | `tests 101, pass 101, fail 0`                                                                                                        |
| `pnpm --filter @smthrs/integrations test -- --run` with `GITHUB_TOKEN`   |  4.62 | exit 0, `Test Files 18 passed, 1 skipped`, `Tests 313 passed, 3 skipped`, coverage 98.81/94.02/98.6/99.2 over thresholds 98/94/98/99 |
| `pnpm --dir packages/{integrations,memory,smthrs-deprecation} run check` |  4.71 | exit 0 each                                                                                                                          |
| `pnpm --dir packages/{integrations,memory,smthrs-deprecation} run lint`  |  4.71 | exit 0 each                                                                                                                          |
| `pnpm --dir examples run check`                                          |  5.00 | exit 0                                                                                                                               |
| `pnpm --dir examples exec vitest run test/09-browser-use.test.ts`        |  5.00 | exit 0, `Tests 2 passed (2)`                                                                                                         |
| `pnpm run test:jsdoc`                                                    |  5.00 | `tests 5, pass 5, fail 0`                                                                                                            |
| `smithers-build lint '//:knownFiles'`                                    |  8.83 | `ok: true`                                                                                                                           |
| `smithers-build test '//scripts:packManifest'`                           |  8.83 | `ok: true`, 1 ran 0 failed                                                                                                           |
| `smithers-build test '//scripts:browserContract'`                        |  8.83 | `ok: true`, 1 ran 0 failed (2.6 s)                                                                                                   |
| `smithers-build test '//scripts:docs'`                                   |  8.83 | `ok: true`, 1 ran 0 failed (40.3 s)                                                                                                  |
| `smithers-build test '//scripts:llms'`                                   |  8.83 | `ok: true`, 1 ran 0 failed                                                                                                           |
| `smithers-build test '//scripts:docsUnit'`                               |  5.00 | `ok: true`, 1 ran 0 failed (91.0 s)                                                                                                  |
| `git status --short` after every gate                                    | 11.30 | 0 lines                                                                                                                              |

`known-files.d.ts` regenerated with `node scripts/generate-known-files.mjs` (4667
to 4669 entries, the two new files) and the llms bundles with `node
scripts/generate-llms.ts`, both inside the commits that add the files.
`packages/flows/test/vitestCoverageIsolation.test.ts` pins `.github/workflows/ci.yml`
only, which this lane does not touch.

## Observations for the orchestrator

1. `docs/releases/1.0.0-rc.0.md:77` says the browser-safe entries live "in
   `scripts/browser-check.mjs`". They now live in `scripts/browser-contract.mjs`,
   which that script imports. The release artifact is yours; the equivalent
   sentence in `docs/pages/contributing.md` was corrected here.
2. `packages/keys/src/README.md` is a source file that no `files` glob packs, the
   same shape as the memory `.sql` files. `packages/keys/package.json` is outside
   this lane's paths, so it is reported rather than changed.
3. `packages/integrations` has no `PACKAGE.ts`, so `smithers-build ci
   '//packages/...'` never runs its suite; only the recursive `pnpm test` does.
   The L1 pin therefore holds under `pnpm test` and not under CI. Giving the
   package a PACKAGE.ts is a structural change (it regenerates `tsconfig.json`,
   `ci.yml`, and `known-files.d.ts`) and belongs to whoever owns that decision.
4. `//scripts:docsUnit` passes at `f63809382b`, so the run-3 blocker B1 is closed
   on this base.
