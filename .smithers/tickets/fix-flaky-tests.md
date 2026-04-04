# Fix and re-enable flaky tests

## Problem

Three tests pass individually but fail intermittently in the full test suite due to
test ordering or shared state leakage. They have been skipped with `describe.skip` /
`test.skip` to keep CI green.

## Skipped tests

1. **`tests/examples-batch-8.test.tsx`** — `smoketest > setup → parallel checks → report`
2. **`tests/examples-batch-3.test.tsx`** — `doc-sync > audit → parallel fixes → PR sequence completes`
3. **`tests/examples-batch-3.test.tsx`** — `fan-out-fan-in > split → parallel process → merge`
4. **`tests/init.e2e.test.ts`** — `smithers init writes the expected workflow-pack layout and it typechecks`

## Root cause hypothesis

These are all example/e2e tests that create temporary databases and workflows. When
run in the full suite (2600+ tests, 240+ files), they likely share:

- Global Effect runtime state that leaks between test files
- SQLite database handles that aren't fully closed
- Filesystem temp directories that collide
- Process-level state from `AsyncLocalStorage` (task runtime)

## Fix approach

1. Investigate which test runs before each flaky test and whether its cleanup is
   incomplete.
2. Add `afterAll` / `afterEach` hooks that explicitly close DB handles and reset
   global state.
3. Use unique temp directories per test file (not just per test) to avoid collisions.
4. Consider running these in separate bun test processes if isolation is needed.
5. Re-enable each test after confirming it passes reliably in 10 consecutive full
   suite runs.

## Verification

- Run `bun test` 10 times. All 3 tests must pass every time.
- No new skipped tests introduced.
