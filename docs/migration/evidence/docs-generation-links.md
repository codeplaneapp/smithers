# Gate: docs-generation-links

Verdict: **PASS**

This file supersedes the FAIL recorded for this gate at `cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba` on 2026-08-31 05:00 to 05:35. This run validates `341c8fa87e2dadbe80d0f0d3258dae112a7d03d3` from the same clean checkout. Every check the gate names is green: `vocs build` exits 0 with 174 routes and zero dead-link warnings, `pnpm docs:llms` rewrites 12 artifacts with 0 bytes changed and `check-llms` confirms them, `check-docs` resolves all 504 internal links and a crawl of the built site finds 0 dead links among 28,242 same-site references, and the deploy workflow's copy step makes the site serve the curated bundles byte-for-byte. The three defects that failed the cd14388ed7 run are closed at this commit: `//scripts:docsUnit` is green because a removed verb now refuses before the control plane boots (`a506d60231`), the built site serves the curated `llms-full.txt` because `docs-deploy.yml` copies it after `vocs build` and `check-llms` guards the served copy (`510621c763`), and `github.com/smithersai/plugins` is reclassified from dead link to publication order because the repository exists and is private.

## Environment

| Item | Value |
| --- | --- |
| Checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4` |
| HEAD | `341c8fa87e2dadbe80d0f0d3258dae112a7d03d3` (`docs(release): consumer overrides note and the browser-contract list's new home`) |
| Submodule | `vendor/jj` at `47589ada7` |
| Working tree | clean before and after every command (`git status --short` empty; `docs/dist` is gitignored); no `packages/cli/dist` exists, so every spawn ran the working-tree source |
| node | v24.18.0 (the rc-contract pins 22.19.0 for CI; no gate here pins a Node version) |
| pnpm | 11.21.0 via corepack |
| bun | 1.4.0 |
| vocs | 2.8.5 (`vocs/2.8.5 darwin-arm64 node-v24.18.0`) |
| Install | frozen offline install from the setup step; no install was re-run |
| Host load | `uptime` 3.3 at the start, 11.3 before `vocs build`, 33.7 to 34.1 around `//scripts:docsUnit` (under the 40 bound the run brief sets) |
| Disk | `/System/Volumes/Data` 99% used, 12 GiB free during the run, 13 GiB after removing `docs/dist` |
| Date | 2026-08-31, 09:16 to 09:22 local |

Raw logs: `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/phase7/logs/docs-generation-links/`. The files `check-docs.log`, `check-llms.log`, `docs-llms-regen.log`, `vocs-build.log`, `built-site-links.log`, `llms-served-vs-committed.log`, `check-llms-red-proof.log`, `removed-verb-db-open.log`, `docs-unit.log`, and `external-links-reprobe.log` were rewritten by this run. `external-links.log`, `external-links-triage.log`, `external-urls.txt`, `docs-unit-rerun.log`, `docs-removals-alone.log`, `removals-harness.{mjs,log}`, `removed-verb-probes.log`, and `probe.sh` remain from the cd14388ed7 run and back the carried-forward triage in section 6.

## 1. Documentation gate and link checker: `check-docs`

```sh
cd <checkout> && node scripts/check-docs.mjs
```

Exit 0. All 17 checks pass, the 16 from the cd14388ed7 run plus a new one from the wave-8 polish-2 lane:

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
✓ the browser tables and counts match the 28 entry points the gate bundles
```

`scripts/docs-links.mjs` is the site's dead-link authority (`vocs.config.ts` sets `checkDeadlinks: "warn"` and defers to it). Log: `check-docs.log`.

## 2. llms bundle regeneration and its check

```sh
node scripts/check-llms.mjs   # exit 0: "✓ 12 documentation artifact(s) are current" (docs/dist absent at this point)
corepack pnpm docs:llms       # exit 0
git status --short            # empty
```

`pnpm docs:llms` output:

```
  core        55 pages  190,071 bytes
  api         34 pages  395,968 bytes
  control     11 pages  11,879 bytes
  operations  13 pages  140,707 bytes
  migration    3 pages  109,260 bytes
  internals   10 pages  110,521 bytes
  full       126 pages  959,516 bytes

12 artifact(s) written, 0 changed.
```

`docs/llms-full.txt` is 959,696 bytes on disk. Logs: `check-llms.log`, `docs-llms-regen.log`.

## 3. Documentation build: `vocs build`

```sh
rm -rf docs/dist && corepack pnpm exec vocs build
```

Exit 0. Final lines:

```
✓ built in 11.3s (from PLUGIN_TIMINGS; vocs:llms buildEnd 37%, 4.2s)
[ssg] processing static generation...
[prune] removed static-only 173 chunk(s) and 0 asset(s) from server bundle
✓ 349 files generated in 3790ms
```

Output: `docs/dist/public` (92 MB) holds 174 HTML files, matching the `renderStrategy: "full-static"` layout `docs-deploy.yml` uploads. The build log contains no dead-link warning (case-insensitive grep for `dead` and `broken` finds 0 lines). Log: `vocs-build.log`.

A crawl of every `href` and `src` in the 174 emitted HTML files against the files on disk (`crawl-built-site.mjs` beside the logs; output in `built-site-links.log`):

```
html files: 174; same-site href/src checked: 28242; external or scheme links skipped: 681
PASS: 0 dead same-site links in the built site
```

## 4. Served llms bundles: the docs-deploy.yml copy step replicated

`.github/workflows/docs-deploy.yml` runs, after `pnpm exec vocs build`: `cp docs/llms.txt docs/llms-full.txt docs/dist/public/`, then `node scripts/check-llms.mjs` a second time. Replicated here in the same order (`llms-served-vs-committed.log`):

```
== pre-copy: vocs' own plugin output in docs/dist/public
llms-full.txt 1,434,323 bytes   llms.txt 24,886 bytes
== after cp docs/llms.txt docs/llms-full.txt docs/dist/public/
llms-full.txt   959,696 bytes   llms.txt  1,494 bytes
== node scripts/check-llms.mjs with docs/dist present
✓ 12 documentation artifact(s) are current
✓ the built site serves 2 curated bundle(s)
check-llms-exit=0
== cmp
docs/dist/public/llms-full.txt vs docs/llms-full.txt: byte-identical
docs/dist/public/llms.txt      vs docs/llms.txt:      byte-identical
== grep counts (identical on both files)
docs/dist/public/llms-full.txt: bytes=959696 jsx-Task=7 'smithers oneshot'=0
docs/llms-full.txt:             bytes=959696 jsx-Task=7 'smithers oneshot'=0
```

The 7 `<Task` occurrences are the migration guide quoting the removed 0.x JSX API; the vocs plugin bundle the copy step replaces carried 40 of them plus 8 `smithers oneshot` mentions and 44 historical 0.x changelog bodies.

Red proof that the widened `check-llms` actually guards the served copy (`check-llms-red-proof.log`): appending one byte to `docs/dist/public/llms-full.txt` makes `check-llms` exit 1 with `docs/dist/public/llms-full.txt is 959697 bytes, not the 959696 bytes of docs/llms-full.txt` and the instruction to run the exact `cp` line from `docs-deploy.yml`; restoring the copy returns it to exit 0. This closes defect 2 of the cd14388ed7 run: `https://smithers.sh/llms-full.txt`, the URL `claude-plugin/skills/smithers/SKILL.md` tells agents to read first, will serve the curated 959 KB bundle once this site deploys.

## 5. Docs unit target: `//scripts:docsUnit` (green)

```sh
corepack pnpm exec smithers-build test '//scripts:docsUnit'
```

Exit 0: `1 targets: 0 hit, 1 ran, 0 failed, 0 skipped (57.4s)`. The target ran fresh (0 cache hits). Host load 33.67 at launch and 34.14 at completion, under the 40 bound; no other command of this gate ran concurrently. Log: `docs-unit.log`.

This closes defect 1 of the cd14388ed7 run, where `scripts/docs-removals.test.mjs` was red in three of three runs because every removed-verb refusal created and opened `.flows/engine.db` and `.flows/control.db` before printing. Commit `a506d60231` (wave 7, cli-refuse-before-boot) makes `packages/cli/src/bin.ts` refuse a removed verb before `NodeControl.layer` boots. The probe from the superseded run, repeated at this commit from an empty directory (`removed-verb-db-open.log`):

```sh
mkdir -p $S/empty $S/home && cd $S/empty
SMITHERS_HOME=$S/home node <checkout>/packages/cli/src/bin.ts ui
# exit 1, one stderr line: smithers ui was removed in 1.0.0-rc.0: ... See https://smithers.sh/migration/1.0#ui
find $S/home $S/empty -type f
# (empty: the refusal creates no files)
```

At cd14388ed7 the same probe left `engine.db` and `control.db` behind and one refusal cost 7.1 s wall; the whole 11-file target now finishes in 57.4 s.

## 6. External links (informational, network)

Carried forward from the cd14388ed7 run's full probe of 348 unique `http(s)` URLs in `docs/pages` (`external-links.log`, `external-links-triage.log`). Only 5 pages changed between cd14388ed7 and 341c8fa87e (`api/patterns.md`, `architecture/browser-support.md`, `contributing.md`, `installation.md`, `package-structure.mdx`); they carry exactly one external URL between them, re-probed on 2026-08-31 (`external-links-reprobe.log`). Zero dead external links remain; two classes wait on publication order.

| Count | Class | Status |
| --- | --- | --- |
| 1 | `https://github.com/smithersai/smithers/blob/main/.github/workflows/ci.yml` (the only external URL on the 5 changed pages) | 200 today: the path also exists on the 0.x `main`. The link serves the intended file only after `v1/rc0-migration` lands on `main`. |
| 168 | Other `https://github.com/smithersai/smithers/blob|tree/main/<path>` from 66 pages (api pages, `examples.md`, generated CLI and control pages) | 404 at the cd14388ed7 probe: GitHub `main` is 0.x (`cfb570f1`); the paths exist only on `v1/rc0-migration`. Publication order: resolves when the branch lands on `main`. Pages unchanged; not re-probed. |
| 70 | `https://smithers.sh/migration/1.0#<verb>` from `docs/pages/migration/1.0.md` (the URL every refusal prints) | 404 at the cd14388ed7 probe: smithers.sh still serves the Mintlify 0.x site. Publication order: resolves when the vocs `docs/dist/public` deploy replaces it. Page unchanged; not re-probed. |
| 2 | `https://github.com/smithersai/plugins` and `.../blob/main/docs/guides/` from `architecture/package-map.md`, `concepts/hosts-and-capabilities.md`, `api/flows.md`, `external.mdx` | Reclassified from dead link to publication order: `gh api repos/smithersai/plugins` prints `"private":true,"visibility":"private"` (anonymous curl sees 404 because GitHub hides private repositories). `docs/migration/publish-runbook.md` names the private plugins repository since `0156f2458e`; the link resolves when the maintainer makes it public. |
| 2 | `https://www.npmjs.com/package/{smthrs,canonicalize}` | 403 to curl; `registry.npmjs.org` returns 200 for both. Not dead. |
| 2 | `api.deepgram.com`, `api.openai.com/v1/audio/transcriptions` in changelog 0.25.0 | 401: auth-gated API endpoints quoted in a historical changelog. Not links. |
| 5 | `smithers.internal`, `control.example.test`, `runbook/approvals` (sample placeholders); `herdr.sh` and `codeplaneapp/smithers/issues/123` (historical changelogs) | Placeholders and historical pages, which `check-docs` exempts. |

## Cleanup

`docs/dist` (92 MB) was removed after the checks; the working tree is clean at `341c8fa87e` and disk free space returned to 13 GiB.

## Verdict

PASS. The documentation build, the llms regeneration and both `check-llms` runs (without and with `docs/dist`), the internal link checks, the built-site crawl, the deploy copy-step replication with byte-identical served bundles and matching `<Task`/`smithers oneshot` counts, and `//scripts:docsUnit` all exit 0 at `341c8fa87e`. Zero broken links: 504 internal links resolve, 28,242 same-site references in the built site resolve, and every non-2xx external URL is publication order (branch landing, site deploy, plugins repository going public), a curl-hostile but live host, or a documented placeholder.
