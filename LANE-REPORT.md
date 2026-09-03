# Convert lane report

## Result

- Converted all 73 tracked legacy declaration modules present at baseline: 72 repository declarations and the implementation-identity fixture. The brief expected 74, but the baseline inventory contained 73. No old-form declaration file remains outside excluded dependency/history trees.
- Every converted module exports one `Package = Smithers.Package({ targets })`. Five packages formerly supplied by root defaults (`evals`, `harness`, `mcp`, `smthrs-deprecation`, and `testing`) now have explicit declarations, preserving all labels.
- Added `.smithers/WORKSPACE.ts` with the repository, Node/pnpm installation, Rust toolchain, host binaries, cache directory, environment-driven remote-cache contract, and embedded repository boundaries. The root had no git hooks to carry over. Cache endpoint/token values remain process-boundary environment state.
- Moved 46 case-colliding documentation manifests to `packages/*/docs/Manifest.ts` and updated their generators/imports.
- Updated declaration discovery, validation, glob boundaries, embedded-workspace pruning, generated-root inputs, documentation, and tests. Mixed old/new declarations, multiple package values, and package-plus-loose-target exports are rejected.
- Regenerated `tsconfig.json`, the documentation bundles, CI (no content drift), and the known-file registry.
- Added the missing `FoundryExec.ts` entry to the existing private build-tool spawn-containment ledger; the base commit introduced that process starter without updating the exhaustive ledger.

Structural verification:

```text
baseline labels: 498
converted labels: 498
diff: empty
converted graph tail:
  "//scripts:releaseSmoke","//scripts:releasePack",data
warnings: []
```

The baseline graph command itself returned this existing nested-repository admission error:

```text
code: graph_failed
message: "declared input is not a regular file: /Users/williamcory/smithers-lanes/convert/vendor/jj"
```

The converted graph succeeds after explicit repository boundaries were added.

## Gates

`pnpm --filter @smthrs/build-cli run check` — pass:

```text
$ tsc -b tsconfig.json && tsc -p tsconfig.test.json --noEmit
```

`pnpm --filter @smthrs/build-cli test` — pass:

```text
Test Files  63 passed (63)
Tests  1042 passed | 2 skipped (1044)
Statements   : 87.06% ( 9738/11185 )
Branches     : 77.33% ( 5811/7514 )
Functions    : 90.22% ( 1366/1514 )
Lines        : 89.8% ( 8760/9754 )
```

`pnpm --filter @smthrs/targets run check` — pass:

```text
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit
```

`pnpm --filter @smthrs/targets test` — pass:

```text
Test Files  61 passed (61)
Tests  1362 passed (1362)
Statements   : 99.03% ( 7603/7677 )
Branches     : 97.32% ( 5424/5573 )
Functions    : 99.18% ( 1214/1224 )
Lines        : 99.38% ( 6746/6788 )
```

The first targets test run failed the unchanged 99% statement gate after discovery code was added:

```text
Statements   : 98.97% ( 7598/7677 )
ERROR: Coverage for statements (98.97%) does not meet global threshold (99%)
Exit status 1
```

The repository-boundary behavior received a test; the rerun above passes without lowering coverage.

`pnpm --filter @smthrs/build-infra test` — pass after correcting its declaration input:

```text
Test Files  15 passed (15)
Tests  224 passed (224)
Statements   : 100% ( 1340/1340 )
Branches     : 100% ( 837/837 )
Functions    : 100% ( 152/152 )
Lines        : 100% ( 1191/1191 )
```

`pnpm --filter @smthrs/flows test` — pass after completing the exhaustive containment ledger:

```text
Test Files  14 passed (14)
Tests  471 passed | 1 skipped (472)
Statements   : 100% ( 314/314 )
Branches     : 100% ( 171/171 )
Functions    : 100% ( 89/89 )
Lines        : 100% ( 297/297 )
```

`pnpm run lint` — pass after formatting five build-reference pages and adding one required JSDoc block:

```text
packages/evals lint: Done
packages/chain lint: Done
packages/create-app lint: Done
packages/build-cli lint$ eslint src --max-warnings=0 && dprint check
packages/build-cli lint: Done
```

`pnpm run circular` — pass:

```text
packages/evals circular: Done
packages/create-app circular: Done
packages/chain circular: Done
packages/build-cli circular$ node scripts/circular.mjs
packages/build-cli circular: Done
```

`pnpm run check` — pass:

```text
packages/build-cli check$ tsc -b tsconfig.json && tsc -p tsconfig.test.json --noEmit
examples check$ tsc -p tsconfig.json --noEmit
apps/ui check$ node scripts/ensure-devkit.mjs && tsc --noEmit
examples check: Done
packages/build-cli check: Done
apps/ui check: Done
```

`pnpm test` — conversion-related suites passed; the root command failed in two existing examples and one load-sensitive UI test:

```text
apps/ui test: (fail) the native main process starts the local origin > prints SMITHERS_LOCAL_ORIGIN on 127.0.0.1 and the origin answers /api/health [5002.33ms]
apps/ui test:   ^ this test timed out after 5000ms.
examples test: FAIL  test/12-agent-live-smoke.test.ts > runs the assembled agent stack against a real OpenAI seat
examples test: Error: Test timed out in 30000ms.
examples test: FAIL  test/18-approval-and-signal.test.ts > gates a launch on a plan approval and ends a durable wait with a signal
examples test: Expected: "/control/ClaimLost"
examples test: Received: "/control/PlanDenied"
examples test: Test Files  2 failed | 34 passed (36)
examples test: Tests  2 failed | 59 passed (61)
Exit status 1
```

The UI package passes in isolation:

```text
1262 pass
0 fail
8408 expect() calls
Ran 1262 tests across 105 files. [12.21s]
```

The examples package still fails in isolation with the same two results: the real OpenAI request exhausts its 30-second budget, and the approval example's checked-in expectation disagrees with its current result. Neither test, its declaration, nor its runtime path changed in this lane; I did not hide the live test or broaden this conversion into unrelated control/example changes.

`pnpm exec smithers-build build '//:ci'` — pass through the current declaration loader; generated workflow content was unchanged:

```text
counts:
  hit: 0
  ran: 1
  failed: 0
  skipped: 0
ok: true
```

`pnpm docs:llms` — pass:

```text
full       132 pages  2,021,077 bytes

12 artifact(s) written, 4 changed.
```

`node scripts/generate-known-files.mjs` and `pnpm exec smithers-build lint '//:knownFiles'` — pass after all file creation/deletion:

```text
//:knownFiles  ran  31.0s
1 targets: 0 hit, 1 ran, 0 failed, 0 skipped (31.0s)
counts:
  hit: 0
  ran: 1
  failed: 0
  skipped: 0
ok: true
```

## Executor caveat

With `.smithers/WORKSPACE.ts` present, the current executor still refuses the `Tsconfig` rule, as anticipated by the lane brief:

```text
1 targets: 0 hit, 0 ran, 1 failed, 0 skipped (4ms)
code: targets_failed
message: 1 of 1 targets failed
retryable: false
```

The current declaration loader wrote the regenerated file but then reported its known output-manifest limitation:

```text
//:tsconfig  failed  163ms  the result carries no output manifest (an exact object is required)
1 targets: 0 hit, 0 ran, 1 failed, 0 skipped (174ms)
```

This is the sibling executor lane's stated responsibility. No conversion work remains.
