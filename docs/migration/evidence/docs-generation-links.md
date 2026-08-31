# Phase 7 gate: docs-generation-links

Verdict: PASS

PLAN Phase 7 line covered: "documentation generation and link checks". The
canonical order comes from `.github/workflows/docs-deploy.yml` (the smithers.sh
publish job): `node scripts/check-docs.mjs`, `node scripts/check-llms.mjs`,
`pnpm exec vocs build`. This gate ran all three plus the llms bundle
regeneration (`pnpm run docs:llms`) and the link-checker unit suite
(`scripts/docs-links.test.mjs`). rc-contract ruling A2 and section 9 exception 2
name these as the rewritten vocs-tree docs gates.

## Environment

| Item | Value |
| --- | --- |
| Checkout | /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout |
| HEAD | `9c464343f0cfada6aa36f0a08144ed7cf1f0ce14` on `v1/rc0-migration` |
| Submodule | `vendor/jj` at `47589ada70c12b3e829b5c98ab32503abad49eac` |
| Node | v24.18.0 (CI pins 22.19.0; the repo floor is >=22.19.0, same as the clean-install gate run) |
| pnpm | 11.21.0 |
| Bun | 1.4.0 (not used by these gates) |
| vocs | 2.8.5 from the lockfile, with `patches/vocs@2.8.5.patch` applied |
| Date | 2026-08-30 |

Dependencies were already installed by the clean-install gate
(`00-clean-install.md`, `pnpm install --frozen-lockfile`, exit 0).

## 1. check-docs (documentation gate, includes the dead-link authority)

Command, run from the checkout root: `node scripts/check-docs.mjs`

The script is the site's dead-link authority: `scripts/docs-links.mjs` resolves
every Markdown link, reference definition, and hand-written `href` on all
pages against the published routes and served assets. vocs' own checker runs in
warning mode by design (header comment in `scripts/docs-links.mjs`).

The gate ran twice. Run 1 piped through `tee`, which masks the script's exit
status in `$?`, so run 2 repeated the command with a direct redirect to record
the exact code. Both runs printed identical check lines. Run 2 exit code:
recorded by `echo "CHECK_DOCS_EXIT=$?"` immediately after the command.

Exit code: 0 (both runs; run 1 also reported exit 0 by the task harness).
Wall time per run: about 10 minutes, dominated by the CLI `--help` catalog and
the generated-pages re-check, which boot the working-tree CLI per command.

Complete output (14 checks, all pass):

```
✓ no em-dashes in the documentation
✓ 171 pages carry a description and a single title
✓ all 503 internal links resolve
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
```

## 2. llms bundle regeneration

Command: `pnpm run docs:llms` (runs `node scripts/generate-llms.ts`)

Exit code: 0. Final output:

```
  core        55 pages  187,404 bytes
  api         34 pages  395,895 bytes
  control     11 pages  11,879 bytes
  operations  13 pages  139,279 bytes
  migration    3 pages  107,352 bytes
  internals   10 pages  110,518 bytes
  full       126 pages  953,437 bytes

12 artifact(s) written, 0 changed.
```

`git status --porcelain -- docs/llms*.txt packages/cli/docs skills/smithers`
printed nothing after the regeneration (exit 0): the 12 committed artifacts
(`docs/llms.txt`, `docs/llms-full.txt`, six per-topic bundles, both
`packages/cli/docs` copies, `skills/smithers/llms-full.txt`, and
`packages/cli/docs/SKILL.md`) are byte-identical to what the generator emits
from `docs/pages` at this revision.

## 3. check-llms (bundle staleness gate)

Command: `node scripts/check-llms.mjs`

Exit code: 0. Final output:

```
✓ 12 documentation artifact(s) are current
```

## 4. Link-checker unit suite

Command: `node --test scripts/docs-links.test.mjs`

Exit code: 0 (pipestatus of the node process). Final output:

```
ℹ tests 7
ℹ pass 7
ℹ fail 0
```

## 5. vocs build (documentation generation)

Command: `pnpm exec vocs build`

Exit code: 0, recorded by `echo "VOCS_BUILD_EXIT=$?"` after the command.
Final output lines:

```
✓ 1648 modules transformed.
✓ built in 17.31s
[ssg] processing static generation...
[prune] removed static-only 173 chunk(s) and 0 asset(s) from server bundle
✓ 349 files generated in 2386ms
VOCS_BUILD_EXIT=0
```

The build wrote the static site to `docs/dist/public` (39 top-level entries,
`renderStrategy: full-static`), the artifact `docs-deploy.yml` publishes. The
only warning in the full log is Rollup's chunk-size advisory for
`playground-modal.client` (5.7 MB pre-gzip); vocs printed no dead-link report.
Full log: the build output was captured to the session scratchpad
(`vocs-build.out`); the lines above are its verdict lines.

## Broken links

None.

- check-docs: `all 503 internal links resolve` (checks every Markdown link,
  reference definition, and hand-written href on all 171 pages against 127
  published routes plus served assets and the deferred-route register, which is
  currently empty).
- Sidebar: `the sidebar reaches all 127 routes the site publishes`, and every
  sidebar link resolves.
- vocs build: no dead-link warnings in the full build log.

## Observations (no gate impact)

- Before this gate ran, `known-files.d.ts` showed as modified in the clean
  checkout: 1,409 inserted lines, all `//vendor/jj/**` entries, consistent with
  a KnownFile regeneration after the submodule was materialized. By the end of
  this gate `git status --porcelain` was empty, so the file matched HEAD again.
  Neither state affects the docs gates, which do not read `known-files.d.ts`.
  If another Phase 7 lane regenerates KnownFiles with the submodule present, it
  should reconcile that drift; it is a build-graph artifact question, not a
  docs question.
- `docs/dist` is untracked build output and is ignored; the working tree ended
  the gate clean (`git status --porcelain` empty).

## Verdict

PASS. Documentation generation (vocs build), llms bundle regeneration and its
staleness check, the full docs gate, and the link checks all exit 0 at
`9c464343f0` with zero broken links.
