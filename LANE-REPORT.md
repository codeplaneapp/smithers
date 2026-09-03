# Integration lane report

## Outcome

The repository now uses `.smithers/WORKSPACE.ts` and `PACKAGE.ts` as its single build declaration and execution path. The converted graph executes end to end, the obsolete loader and executor entry point are gone, stale root agent instructions are removed, and generated artifacts are current.

## Changes

- Fixed generator output propagation and the read/input declarations needed by real target execution.
- Added the workspace sandbox and repository-boundary declarations required by the converted root graph.
- Made `.smithers/WORKSPACE.ts` mandatory and made any obsolete declaration in a workspace a hard error naming that file.
- Removed legacy discovery, loading, execution fallthroughs, fixtures, tests, renderers, and mode terminology.
- Removed root `CLAUDE.md` and the `AGENTS.md` symlink.
- Regenerated CI, docs bundles, documentation pages, and the known-files inventory.

## Validation

- `pnpm exec smithers-build query '//...'` — passed.
- `pnpm exec smithers-build graph '//...'` — passed.
- `pnpm exec smithers-build lint '//:tsconfig'` and `build '//:tsconfig'` — passed.
- `pnpm exec smithers-build build '//:ci'` and `lint '//:ci'` — passed; the generated workflow is current.
- `pnpm exec smithers-build ci '//packages/canonical/...'` — passed.
- `pnpm exec smithers-build test '//scripts/...'` — passed, 74 targets with 73 executed and no failures.
- `pnpm exec smithers-build install '//...'` — passed; the `//:nodeModules` and `//:lockfile` targets executed successfully.
- `pnpm run check` — passed.
- `pnpm run lint` — passed.
- `pnpm run circular` — passed.
- `pnpm exec smithers-build ci '//packages/...'` — passed after the source conversion: 411 targets, 52 cache hits, 355 executed, zero failed. After the final test-hardening changes, two full reruns each reached 410/411: one hit the isolated-green observability timing assertion described below, and one hit the isolated-green Node 26 build-infra runner error described below. Every changed-package target passed in both reruns.
- Build-cli package suite — passed with the original coverage floors: 51 files, 848 passed, one skipped.
- Targets package suite — passed with the original coverage floors: 61 files, 1,364 passed.
- Gateway package suite — passed: 13 files, 256 passed, 100% coverage.
- UI suite — passed in isolation: 1,533 passed, seven skipped, zero failed.
- Build-infra suite — passed in isolation: 15 files, 224 passed, 100% coverage.
- The required terminology grep reports no matches.

The final `pnpm --recursive --if-present --no-bail run test` sweep reported the two failures explicitly permitted by the lane brief:

- `examples/test/12-agent-live-smoke.test.ts`: `Test timed out in 30000ms.`
- `examples/test/18-approval-and-signal.test.ts`: expected `/control/ClaimLost`, received `/control/PlanDenied`.

That sweep also observed two contention-only runner failures. `@smthrs/build-infra` passed all 224 assertions but Node 26 reported three `FileHandle object was closed during garbage collection` errors; its immediate isolated rerun passed with 100% coverage. The UI completed neither its summary nor process shutdown after the rest of the recursive sweep had finished and was terminated; its immediate isolated rerun passed all 1,533 runnable tests.

The final package-graph retries exposed the same build-infra FileHandle runner error once and an observability wall-clock assertion once (`18.4` reference encodes against a `<12` bound). Immediate isolated reruns passed: build-infra, 224 tests at 100% coverage; observability, 64 tests at 100% coverage. These are reported as reds, not waived as lane-permitted example failures.

## Decisions and notes

- Generator targets publish their ordinary exact-object output manifest; there is no Tsconfig-specific executor branch.
- The workspace explicitly selects the no-sandbox backend because sandbox selection is a repository policy choice, while target execution still enforces declared reads and writes.
- Coverage floors remain at their pre-lane values; tests for live shared executor utilities were retained or ported to the PACKAGE executor.
- Two documentation-contract tests were made formatting-independent: package table insertion now accepts aligned Markdown columns, and fenced refusal extraction now parses fences in order instead of confusing closing fences for openings.
- Real-workspace UI tests now skip a host checkout that the current loader cannot open and assert graph invariants instead of a mutable external repository's exact node count.
