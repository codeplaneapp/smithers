# migration-docs lane report

## Changed

- Deleted `PLAN.md`, `docs/migration/`, the legacy-absence gate, and the migration-only docs contract/route generators and tests.
- Removed their package scripts, build targets, tooling exclusions, sidebar entry, generated-file inventory entries, and dangling migration-plan/evidence references.
- Rebased documentation generation and checks on live CLI registries, schemas, projections, package metadata, and maintained release pages; added `scripts/docs-shared.mjs` for the remaining shared parsers.
- Kept the shipped `packages/migrate` product, the user-facing `docs/pages/migration` guide, and architecture documentation.
- Regenerated package API docs, CLI pages, llms bundles, `tsconfig.json`, CI, and `known-files.d.ts`. No `packages/build-cli` source was changed.

## Decisions

- Deleted `docs/migration/publish-runbook.md` because `docs/internal/release-runbook.md` is the maintained operator runbook.
- Deleted `docs/migration/plue-consumer-contract.md` because it recorded a completed cutover; current gateway behavior remains documented in the API and support matrix.
- Deleted the route-plan tooling and `/routes` page because they existed to police the disposition ledger, not to serve users.
- Preserved the 0.x-to-1.0 user migration guide and migration tool documentation because they are released product surfaces.

## Gates

### PASS: `pnpm run check`

```text
examples check: Done
packages/build-cli check: Done
apps/ui check: Done
```

### PASS: `pnpm run lint`

```text
packages/evals lint: Done
packages/chain lint: Done
packages/create-app lint: Done
packages/build-cli lint$ eslint src --max-warnings=0 && dprint check
packages/build-cli lint: Done
```

### PASS: `pnpm run circular`

```text
packages/evals circular: Done
packages/create-app circular: Done
packages/chain circular: Done
packages/build-cli circular$ node scripts/circular.mjs
packages/build-cli circular: Done
```

### PASS: `pnpm exec smithers-build test '//scripts/...'`

```text
74 targets: 0 hit, 74 ran, 0 failed, 0 skipped (129.9s)
verb: test
pattern: //scripts/...
jobs: 16
durationMs: 129918.50833400001
counts:
  hit: 0
  ran: 74
  failed: 0
  skipped: 0
ok: true
```

### PASS: generated documentation checks

```text
✓ the sidebar reaches all 132 routes the site publishes
✓ every stated package count matches the 40 published packages
✓ all 74 anchors the removal messages link to have a heading in the migration guide
✓ the browser tables and counts match the 28 entry points the gate bundles
```

```text
✓ 12 documentation artifact(s) are current
✓ no em-dashes in the documentation
✓ 176 pages carry a description and a single title
✓ all 507 internal links resolve
✓ every documented @smthrs import resolves to a workspace package
✓ nothing shipped is described as pending
```

### PASS: generated root files

`pnpm exec smithers-build build '//:ci'`, `node scripts/generate-known-files.mjs`, `pnpm exec smithers-build lint '//:tsconfig'`, and `pnpm exec smithers-build lint '//:ci'` completed successfully. Final tail:

```text
counts:
  hit: 1
  ran: 0
  failed: 0
  skipped: 0
ok: true
```

### PASS: isolated pinned-file test

`pnpm --filter @smthrs/flows exec vitest run test/vitestCoverageIsolation.test.ts --coverage.enabled=false`

```text
Test Files  1 passed (1)
Tests  267 passed (267)
Duration  1.02s
```

### FAIL: `pnpm --filter @smthrs/flows test`

The requested package gate reaches an existing process-containment violation in build-cli source, which this lane was explicitly forbidden to change:

```text
FAIL test/spawnContainment.test.ts > child-process containment conformance > starts child processes only through the host's spawner
AssertionError: expected [ 'build-cli/src/FoundryExec.ts' ] to deeply equal []

Test Files  1 failed | 13 passed (14)
Tests  1 failed | 469 passed | 1 skipped (471)
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @smthrs/flows@1.0.0-rc.0 test: `vitest`
Exit status 1
```

### FAIL: `pnpm test`

The repo-wide gate stops at the pre-existing `@smthrs/targets` coverage shortfall; this lane changed no targets implementation and did not lower thresholds. Direct `pnpm --filter @smthrs/targets test` reproduction tail:

```text
Test Files  61 passed (61)
Tests  1361 passed (1361)
Statements   : 98.96% ( 7588/7667 )
Branches     : 97.23% ( 5411/5565 )
Functions    : 98.93% ( 1210/1223 )
Lines        : 99.35% ( 6737/6781 )
ERROR: Coverage for functions (98.93%) does not meet global threshold (99%)
ERROR: Coverage for statements (98.96%) does not meet global threshold (99%)
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @smthrs/targets@0.1.0 test: `vitest`
Exit status 1
```

## Remaining

The migration-docs lane is complete. The two failing gates above require work in `packages/build-cli` and `packages/targets`, both outside this lane.
