# Phase 7 gate: docs-generation-links

Verdict: PASS

PLAN Phase 7 line covered: "documentation generation and link checks". The
canonical order comes from `.github/workflows/docs-deploy.yml` (the smithers.sh
publish job): `node scripts/check-docs.mjs`, `node scripts/check-llms.mjs`,
`pnpm exec vocs build`. This gate ran those three, the llms bundle regeneration
named by the root `package.json` (`docs:llms` = `node scripts/generate-llms.ts`)
with a clean-tree check after it, a standalone dead-link enumeration through
`scripts/docs-links.mjs`, and the `docsUnit` test group from `scripts/BUILD.ts`.
rc-contract ruling A2, row R-25, and section 9 exception 2 name `check-docs`,
`check-llms`, and `pnpm docs:llms` as the rewritten vocs-tree docs gates.

This file replaces the evidence recorded at `9c464343f0` in full. Every number
below was measured at `20b32c6316`.

## Environment

| Item | Value |
| --- | --- |
| Checkout | /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-2 |
| HEAD | `20b32c6316487497301db74ec70cbe951428ef53` on `v1/rc0-migration` (`git describe`: `v0.35.0-401-g20b32c6316`) |
| Submodule | `vendor/jj` at `47589ada70c12b3e829b5c98ab32503abad49eac` |
| Node | v24.18.0 (CI pins 22.19.0; the repo floor is >=22.19.0) |
| pnpm | 11.21.0 |
| Bun | 1.4.0 (not used by these gates) |
| vocs | 2.8.5 (`node_modules/vocs/package.json`), `patches/vocs@2.8.5.patch` applied through `pnpm-workspace.yaml` `patchedDependencies` |
| vite | 8.2.1 (from the vocs build banner) |
| Date | 2026-08-31, 07:10Z to 07:20Z |
| Load | `uptime` 1-minute load 39.67 at start, 17 to 22 during the runs, 4.10 at the end |

Dependencies were installed by the Phase 7 setup agent. No `pnpm install` ran
in this gate. `git status --porcelain` printed 0 lines before the first command.

## 1. check-docs (documentation gate, includes the dead-link authority)

Command, run from the checkout root:

```
timeout 1500 node scripts/check-docs.mjs; echo "CHECK_DOCS_EXIT=$?"
```

The command ran under `nohup` with stdout and stderr redirected to a log file,
and the session waited on that log in the foreground with a bounded loop
(`timeout 570 sh -c "until grep -q CHECK_DOCS_EXIT <log>; do sleep 5; done"`).
The Bash tool caps one foreground call at 600 seconds, which is shorter than the
1500-second bound the gate asked for; the log-plus-bounded-wait shape keeps the
run alive across that cap without a background monitor.

Started 07:10:56Z, finished 07:12:17Z: 81 seconds wall time.

Exit code: 0.

Complete output (16 checks, all pass):

```
✓ no em-dashes in the documentation
✓ 171 pages carry a description and a single title
✓ all 504 internal links resolve
✓ every documented @smthrs import resolves to a workspace package
✓ nothing shipped is described as pending
✓ the CLI catalog matches 26 commands from --help
✓ no page outside the migration guide names a removed surface
✓ every documented CLI invocation uses the 1.0 command
✓ no hyphenated angle-bracket placeholders in the documentation
✓ 43 generated docs pages are current
✓ the route plan covers 90 kept assets and 36 deletion rules
✓ the sidebar reaches all 127 routes the site publishes
✓ the compatibility promise is verbatim in 3 places
✓ every stated package count matches the 40 names in contract section 3.1
✓ no page sits in one of the 4 moved trees, and 0 deferred route is still waiting for its page
✓ all 74 anchors the removal messages link to have a heading in the migration guide
CHECK_DOCS_EXIT=0
```

`scripts/docs-links.mjs` is the site's dead-link authority: it resolves every
Markdown link, reference definition, and hand-written `href` on every page
against the published routes, the served assets, and the deferred-route
register. vocs' own checker runs in warning mode by design
(`vocs.config.ts:28`, `checkDeadlinks: "warn"`).

## 2. check-llms (bundle staleness gate)

Command: `node scripts/check-llms.mjs; echo "CHECK_LLMS_EXIT=$?"`

Exit code: 0. Complete output:

```
✓ 12 documentation artifact(s) are current
CHECK_LLMS_EXIT=0
```

## 3. llms bundle regeneration and idempotency

Command: `pnpm run docs:llms; echo "DOCS_LLMS_EXIT=$?"` (runs
`node scripts/generate-llms.ts`, the generator the root `package.json` names).

Exit code: 0. Complete output:

```
$ node scripts/generate-llms.ts
  core        55 pages  187,404 bytes
  api         34 pages  395,895 bytes
  control     11 pages  11,879 bytes
  operations  13 pages  139,279 bytes
  migration    3 pages  109,260 bytes
  internals   10 pages  110,518 bytes
  full       126 pages  955,345 bytes

12 artifact(s) written, 0 changed.
DOCS_LLMS_EXIT=0
```

Clean-tree check immediately after the regeneration:

```
git status --short          -> (no output)
git status --porcelain | wc -l   -> 0
```

The 12 committed artifacts (`docs/llms.txt`, `docs/llms-full.txt`, six
`docs/llms-<topic>.txt` bundles, `packages/cli/docs/llms.txt`,
`packages/cli/docs/llms-full.txt`, `packages/cli/docs/SKILL.md`,
`skills/smithers/llms-full.txt`) are byte-identical to what the generator emits
from `docs/pages` at this revision.

## 4. vocs build (documentation generation)

Command: `timeout 570 pnpm exec vocs build > <log> 2>&1; echo "VOCS_BUILD_EXIT=$?"`

Started 07:12:40Z, finished 07:13:29Z: 49 seconds wall time.

Exit code: 0. The log is 1,127 lines; the verdict lines:

```
[1/5] analyze client references...
vite v8.2.1 building rsc environment for production...
✓ 1648 modules transformed.
✓ built in 17.75s
...
✓ built in 6.72s
[ssg] processing static generation...
[prune] removed static-only 173 chunk(s) and 0 asset(s) from server bundle
✓ 349 files generated in 4840ms
VOCS_BUILD_EXIT=0
```

Outputs: `docs/dist/{preview.js,public,serve-node.js,server}`;
`docs/dist/public` holds 39 top-level entries and 173 `index.html` pages, with
`docs/dist/public/index.html` present. `renderStrategy: "full-static"`
(`vocs.config.ts:22`) is the shape `docs-deploy.yml` uploads from
`docs/dist/public`.

Warnings in the log: Rollup's chunk-size advisory for
`playground-modal.client` (5,722 kB before gzip) and a `PLUGIN_TIMINGS`
notice. `grep -i "deadlink|dead link|dead-link"` over the full log matched
nothing (grep exit 1): vocs' warning-mode checker reported no dead link.

`docs/dist` is ignored (`.gitignore:5`, `dist/`). `git status --porcelain`
printed 0 lines after the build.

## 5. Link check through scripts/docs-links.mjs

`scripts/docs-links.mjs` exports functions (`linkTargets`, `isInternal`,
`resolveLink`, `deadLinks`, `headingAnchors`, `anchorsLinkedTo`,
`missingAnchors`) and has no `main` or `process.argv` handling, so
`node scripts/docs-links.mjs` prints nothing. The link check the docs gate
scripts expose is check-docs check 3 (section 1 above). To record the count
independently, a 12-line script in the session scratchpad imported
`deadLinks` and `linkTargets` from the checkout's `scripts/docs-links.mjs`,
`pages` and `assets` from `scripts/docs-pages.mjs`, and `deferredRoutes` from
`scripts/docs-routes.mjs`, and ran the same call check-docs runs.

Exit code: 0. Output:

```
{
  "pages": 171,
  "routes": 171,
  "servedAssets": 43,
  "deferredRoutes": 0,
  "internalTargets": 504,
  "externalOrHashTargets": 451,
  "result": {
    "checked": 504,
    "dead": []
  }
}
```

171 routes here against 127 in the sidebar check: check-docs excludes the 44
historical changelog pages from the sidebar count (`isHistorical` in
`scripts/docs-pages.mjs`); every one of the 171 pages is still a link target.

## 6. docsUnit test group

`scripts/BUILD.ts:279` declares `docsUnit` over ten test files. Command:

```
timeout 570 node --test scripts/docs-contract.test.mjs scripts/docs-deploy.test.mjs \
  scripts/docs-links.test.mjs scripts/docs-removals.test.mjs scripts/docs-render.test.mjs \
  scripts/docs-routes.test.mjs scripts/docs-sidebar.test.mjs scripts/generate-docs-pages.test.mjs \
  scripts/generate-llms.test.mjs scripts/llms-version-guard.test.ts
```

Run 1 (started about 07:13:35Z, 1-minute load 16 to 19, immediately after the
vocs build and beside the other Phase 7 gate agents): one test failed,
`docs-removals.test.mjs:113`, "every removed verb really prints its documented
sentence":

```
actual: [ 'rewind: did not exit', 'fork: did not exit', 'timetravel: did not exit', 'restore: did not exit' ],
expected: [],
```

Run 1 was piped through `tail`, and the zsh `PIPESTATUS` spelling used to read
the node exit code printed empty, so run 1's exit code is not recorded; the
assertion diff above is its failure evidence.

Run 2 (07:15:53Z to 07:17:25Z, same command, output redirected to a log file,
exit code read directly):

```
ℹ tests 118
ℹ suites 0
ℹ pass 118
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 92573.451416
DOCS_UNIT_EXIT=0
```

Cause of the run 1 failure: `runCli` in `scripts/docs-help.mjs:90` kills a
spawned CLI with SIGKILL after `timeoutMs ?? 15000` and reports
`exited: false`; the test spawns the working-tree CLI eight at a time for every
removed verb. Spawned one at a time at 1-minute load 4.10, each of the four
verbs exits on its own and prints the documented sentence:

```
rewind:     exit=1 wall=7.6s  smithers rewind was removed in 1.0.0-rc.0: ... See https://smithers.sh/migration/1.0#rewind
fork:       exit=1 wall=7.3s  smithers fork was removed in 1.0.0-rc.0: ... See https://smithers.sh/migration/1.0#fork
timetravel: exit=1 wall=8.7s  smithers timetravel was removed in 1.0.0-rc.0: ... See https://smithers.sh/migration/1.0#timetravel
restore:    exit=1 wall=7.3s  smithers restore was removed in 1.0.0-rc.0: ... See https://smithers.sh/migration/1.0#restore
```

A 7 to 9 second boot per verb on an idle machine leaves under 2x headroom
against the 15 second bound once eight boots share the CPU with other gates.
The verbs are refused, the guide matches the binary, and the test is green at
normal load; the bound is what failed, not the documentation.

## Broken links

None.

- check-docs check 3: `all 504 internal links resolve` across 171 pages, 171
  routes, 43 served assets, and an empty deferred-route register.
- Standalone enumeration through `scripts/docs-links.mjs`: `checked: 504`,
  `dead: []`.
- check-docs check 16: all 74 anchors the CLI removal messages link to have a
  heading in `docs/pages/migration/1.0.md`.
- Sidebar: `the sidebar reaches all 127 routes the site publishes`.
- vocs build: no dead-link line in the 1,127-line build log.

## Observations (no gate impact)

- `scripts/docs-removals.test.mjs` is load-sensitive through the 15 second
  SIGKILL bound in `scripts/docs-help.mjs` `runCli`. On this machine with
  other Phase 7 gates running it failed once and passed once. Any Phase 7 lane
  that runs `docsUnit` or `//scripts/...` under load should expect this row
  and rerun it before reading it as a docs defect. Raising the bound or the
  test's `timeoutMs` is a `scripts/` change for the maintainer, not a docs
  edit, and it was not made in the clean checkout.
- Compared with the `9c464343f0` evidence: check-docs grew from 15 to 16
  checks (the 74-anchor check), the internal link count moved from 503 to
  504, and the `migration` bundle grew from 107,352 to 109,260 bytes
  (`full` from 953,437 to 955,345). All committed bundles match the generator.
- The working tree ended the gate clean: `git status --porcelain` printed 0
  lines after the regeneration and again after the vocs build.

## Verdict

PASS. At `20b32c6316` from the clean checkout, `check-docs` (16 checks, 504
internal links, 0 dead), `check-llms` (12 artifacts current), the `docs:llms`
regeneration (0 changed, clean tree), `pnpm exec vocs build` (exit 0, 349
files, 173 pages), the standalone dead-link enumeration (0 dead), and the
`docsUnit` group (118 of 118 on the recorded run) all exit 0 with zero broken
links.
