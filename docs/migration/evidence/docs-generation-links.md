# Gate: docs-generation-links

Verdict: **FAIL**

The three checks the gate names are green: `vocs build` exits 0 and emits 174 routes with zero dead-link warnings, `pnpm docs:llms` rewrites 12 artifacts with 0 bytes changed and `check-llms` confirms them, and `check-docs` resolves all 504 internal links (a crawl of the built site adds 28,241 same-site links with 0 dead). The gate fails on two defects found while running the docs gate family in the same checkout: the docs unit target `//scripts:docsUnit` is red because every removed-verb refusal opens two SQLite databases before it prints, and the built site ships vocs' auto-generated `llms-full.txt` (1.43 MB, 40 JSX `<Task` tags, 8 `smithers oneshot` mentions) instead of the curated 957 KB bundle that `smithers docs --full`, the installed skill, and `check-llms` agree on. One external link target, `https://github.com/smithersai/plugins`, returns 404 from five pages.

## Environment

| Item | Value |
| --- | --- |
| Checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4` |
| HEAD | `cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba` on `v1/rc0-migration` (GitHub `main` is `cfb570f1`, GitHub `v1/rc0-migration` is `0d068d87`) |
| Submodule | `vendor/jj` at `47589ada70c1` |
| Working tree | clean before and after every command (`git status --short` empty; `docs/dist` and `.flows` are gitignored) |
| node | v24.18.0 (the rc-contract pins 22.19.0 for CI; no gate here pins a Node version) |
| pnpm | 11.21.0 |
| bun | 1.4.0 |
| vocs | 2.8.5 (`pnpm exec vocs --version`: `vocs/2.8.5 darwin-arm64 node-v24.18.0`) |
| Install | `node_modules/.modules.yaml` present from the setup agent's frozen install; no install was re-run |
| Host load | 16 cores; `uptime` load average 59 to 62 during the first runs (other Phase 7 lanes were running `smithers release`, `smithers review`, eslint, and tsc in this checkout), 9 to 17 during the reruns |
| Disk | `/System/Volumes/Data` 99% used, 14 GiB free |
| Date | 2026-08-31, 05:00 to 05:35 local |

Raw logs: `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/phase7/logs/docs-generation-links/`.

## 1. Documentation gate and link checker: `check-docs`

```sh
cd <checkout> && node scripts/check-docs.mjs
```

Exit 0 (4 min 3 s wall under load 60). Final lines:

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
```

`scripts/docs-links.mjs` is the site's dead-link authority (`vocs.config.ts` sets `checkDeadlinks: "warn"` and defers to it). Log: `check-docs.log`.

## 2. llms bundle regeneration and its check

```sh
node scripts/check-llms.mjs        # exit 0: "✓ 12 documentation artifact(s) are current"
pnpm docs:llms                     # exit 0
git status --short                 # empty
```

`pnpm docs:llms` output:

```
  core        55 pages  187,932 bytes
  api         34 pages  395,895 bytes
  control     11 pages  11,879 bytes
  operations  13 pages  140,707 bytes
  migration    3 pages  109,260 bytes
  internals   10 pages  110,518 bytes
  full       126 pages  957,301 bytes

12 artifact(s) written, 0 changed.
```

The 12 checked paths (`checkedPaths` in `scripts/optimize-llms-full.ts`): `docs/llms.txt`, `docs/llms-full.txt`, `docs/llms-{core,api,control,operations,migration,internals}.txt`, `packages/cli/docs/llms.txt`, `packages/cli/docs/llms-full.txt`, `skills/smithers/llms-full.txt`, `packages/cli/docs/SKILL.md`. `docs/llms-full.txt` is 957,481 bytes. Logs: `check-llms.log`, `docs-llms-regen.log`.

## 3. Documentation build: `vocs build`

```sh
rm -rf docs/dist && pnpm exec vocs build
```

Exit 0 (2 min 19 s wall). Final lines:

```
✓ built in 37.72s
[PLUGIN_TIMINGS] Your build spent 77% of 37.7s inside plugin hooks (29.2s).
  - vocs:llms buildEnd (46%, 17.5s, 1 call)
[ssg] processing static generation...
[prune] removed static-only 173 chunk(s) and 0 asset(s) from server bundle
✓ 349 files generated in 13502ms
```

Output: `docs/dist/public` (92 MB) holds 174 HTML files including `index.html`, `404.html`, `cli/index.html`, and `migration/1.0/index.html`, matching the `renderStrategy: "full-static"` layout `docs-deploy.yml` uploads. The build log contains no dead-link warning (grep for `dead`, `broken`, `not found` finds none). Log: `vocs-build.log`.

### Built-site crawl

A crawl of every `href` and `src` in the 174 emitted HTML files against the files on disk (`crawl-built-site.mjs` beside the logs; output in `built-site-links.log`):

```
html files: 174; same-site href/src checked: 28241; external or scheme links skipped: 681
PASS: 0 dead same-site links in the built site
```

## 4. Docs unit target: `//scripts:docsUnit` (red)

```sh
pnpm exec smithers-build test '//scripts:docsUnit'
```

Run 1 (05:06, load 60): exit 1, `1 targets: 0 hit, 0 ran, 1 failed`; 124 pass, 1 fail, 1 cancelled. `scripts/docs-removals.test.mjs` "every removed verb really prints its documented sentence" hit its 120,000 ms timeout; "a surviving parent's removed forms are documented and refuse" reported all 8 forms (`gateway status|stop`, `workflow run|path|create|inspect|skills|doctor`) as `did not exit`.

Run 2 (05:19, load 13): exit 1; 125 pass, 1 fail. The same test finished in 98 s and reported 8 verbs as `did not exit` (`human`, `ask-human`, `node`, `tail`, `review`, `release`, `test`, `docs-full`).

Run 3, the file alone (`node --test scripts/docs-removals.test.mjs`, 05:21, load 9): exit 1; 6 pass, 1 fail. The same test reported 7 verbs printing a database error instead of the refusal: `ui`, `gui`, `monitor`, `supervisor`, `top`, `optimize` printed `Error: disk I/O error`; `supervise` printed `SqlError: Failed to execute statement`.

The other 10 test files in the target, including `docs-links.test.mjs`, pass in every run. Logs: `docs-unit.log`, `docs-unit-rerun.log`, `docs-removals-alone.log`.

### Root cause: the refusal path opens SQLite

`packages/cli/src/bin.ts` `main` short-circuits only `--help` and `--version` (`documentRequested`). Every other invocation first resolves `NodeControl.config` and runs the command tree under `Effect.provide(NodeControl.layer(applicationConfig))`, and a hidden removed verb's handler (`Command.ts` `removedCommands`) runs inside that layer. Proof from an empty directory:

```sh
mkdir -p $S/empty $S/home && cd $S/empty
SMITHERS_HOME=$S/home node <checkout>/packages/cli/src/bin.ts ui
# exit 1, stderr: smithers ui was removed in 1.0.0-rc.0: ... See https://smithers.sh/migration/1.0#ui
find $S/home $S/empty -type f
# empty/.flows/engine.db
# empty/.flows/control.db
```

`--version` from the same directory creates nothing. The test spawns 67 verbs 8 at a time with `cwd: repoRoot` and a 15,000 ms `execFile` timeout (`scripts/docs-help.mjs` `runCli`), so 8 processes at a time create and open `<checkout>/.flows/engine.db` and `control.db` while the other Phase 7 lanes' `smithers release` and `smithers review` processes use the same files. One cold start costs 7.1 s wall and 6.2 s CPU on this host (`time node packages/cli/src/bin.ts rewind`, twice, and the same for `dist/esm/bin.js`), which leaves 8 s of headroom for the shared SQLite open under the 15 s bound. Log: `removed-verb-db-open.log`, `removed-verb-probes.log`.

### The claim the test makes is true

A harness with the same data and comparison as the test but a 120 s per-spawn bound and 4-way concurrency (`removals-harness.mjs` beside the logs, output in `removals-harness.log`):

```
entry=<checkout>/packages/cli/src/bin.ts
bare verbs=67 surviving-parent forms=8 total spawns=75
spawn wall ms: min=7262 median=7486 max=9810; spawns over the test's 15000 ms bound: 0/75
  gateway status: exited=true 8650ms first line="smithers gateway status was removed in 1.0.0-rc.0: ..."
  workflow run: exited=true 8616ms first line="smithers workflow run was removed in 1.0.0-rc.0: ..."
PASS: all 75 removed verbs and forms print their documented sentence
```

Note for whoever reruns this: `packages/cli/dist/esm/bin.js` appeared in the checkout at 05:08, written by another lane. `packages/cli/bin/smithers.mjs` prefers `dist` when it exists, so the launcher no longer runs the working-tree source that CI runs. `check-docs` ran before the dist existed; the harness passes `entry: packages/cli/src/bin.ts` explicitly.

## 5. Served llms bundle differs from the checked bundle

vocs' built-in llms plugin (`vocs:llms buildEnd` in the build log) writes its own `docs/dist/public/llms.txt` (24,886 bytes) and `docs/dist/public/llms-full.txt` (1,432,111 bytes). `docs-deploy.yml` uploads `docs/dist/public`, so smithers.sh serves these, not the 12 artifacts `check-llms` guards. `claude-plugin/skills/smithers/SKILL.md` lines 17, 141, and 156 instruct agents to read `https://smithers.sh/llms-full.txt` first.

```
docs/dist/public/llms-full.txt: bytes=1432111 jsx-Task-tags=40 'smithers oneshot'=8 version-stamp=0
docs/llms-full.txt:             bytes= 957481 jsx-Task-tags=7  'smithers oneshot'=0 version-stamp=7
cmp docs/dist/public/llms-full.txt docs/llms-full.txt -> differ: char 11, line 1
```

The vocs bundle carries the 44 historical 0.x changelog bodies that `scripts/generate-llms.test.mjs` ("no bundle carries a Smithers 0.x changelog") excludes from the curated bundle. No `docs/public` directory exists to override the plugin output. Log: `llms-served-vs-committed.log`.

## 6. External links (informational, network)

348 unique `http(s)` URLs in `docs/pages` were probed with `curl -I -L --max-time 15`, falling back to `GET` (`external-links.log`, classification in `external-links-triage.log`): 98 return 2xx, 250 do not.

| Count | Class | Status |
| --- | --- | --- |
| 169 | `https://github.com/smithersai/smithers/blob|tree/main/<path>` from 66 pages (api pages, `examples.md`, generated CLI and control pages) | 404 today: GitHub `main` is 0.x (`cfb570f1`); the paths exist only on `v1/rc0-migration`. Resolves when the branch lands on `main`. |
| 70 | `https://smithers.sh/migration/1.0#<verb>` from `docs/pages/migration/1.0.md` (the URL every refusal prints) | 404 today: smithers.sh still serves the Mintlify 0.x site on Vercel (`/` and `/installation` 200, `/migration/1.0` 404). Resolves when the vocs `docs/dist/public` deploy replaces it. |
| 2 | `https://github.com/smithersai/plugins` and `.../blob/main/docs/guides/` from `architecture/package-map.md`, `concepts/hosts-and-capabilities.md`, `api/flows.md`, `external.mdx` | 404: the repository does not exist publicly. Dead link. |
| 2 | `https://www.npmjs.com/package/{smthrs,canonicalize}` | 403 to curl; `registry.npmjs.org` returns 200 for both. Not dead. |
| 2 | `api.deepgram.com`, `api.openai.com/v1/audio/transcriptions` in changelog 0.25.0 | 401: auth-gated API endpoints quoted in a historical changelog. Not links. |
| 5 | `smithers.internal`, `control.example.test`, `runbook/approvals` (sample placeholders); `herdr.sh` and `codeplaneapp/smithers/issues/123` (historical changelogs 0.34.0 and 0.15.1) | Placeholders and historical pages, which `check-docs` exempts. |

## Verdict

FAIL. The build, the bundle regeneration and its check, and the internal link checks pass with zero broken internal links. The gate fails because:

1. `//scripts:docsUnit`, a target the required CI `test` job runs via `smithers-build test '//scripts/...'`, is red in three of three runs on this host. The cause is in the CLI, not in the docs: every removed-verb refusal creates and opens `.flows/engine.db` and `.flows/control.db` in the working directory before it prints, so 8 concurrent spawns contend on two SQLite files and either exceed the 15 s bound or surface `disk I/O error`. Fix in `packages/cli/src/bin.ts` (refuse removed verbs before `NodeControl.layer`, the way `--help` and `--version` already skip startup), or give each spawn in `scripts/docs-removals.test.mjs` its own working directory. All 75 refusals print the documented sentence when given 120 s.
2. The generated site serves vocs' auto-generated `llms-full.txt` (1.43 MB, 44 historical 0.x changelogs, 40 JSX `<Task` tags, 8 `smithers oneshot` mentions, no version stamp) at the URL the shipped skill tells agents to read first, instead of the 957 KB bundle `check-llms` guards. Fix by disabling the vocs llms emission or overriding it with the curated bundles in the served public directory, and extend `check-llms` to the served copy.
3. Five pages link to `https://github.com/smithersai/plugins`, which returns 404.

Cutover-order dependencies, not defects: 169 `github.com/smithersai/smithers/blob/main` links and 70 `smithers.sh/migration/1.0` links resolve only after the branch lands on `main` and the vocs site is deployed.
