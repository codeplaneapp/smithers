# 6LARP Assessment TODO

Objective: critically evaluate whether shipped code is real or performative, then fix proven issues from most complicated to simplest.

## Findings

- [x] `packages/time-travel/src/fork/forkRunEffect.js` writes the child snapshot/run before the branch row without an enclosing transaction. If branch persistence fails, tests document that partial child state can be left behind. Fixed by making fork creation atomic and updating the mid-creation failure test to prove rollback.
- [x] `packages/db/src/sql-message-storage.js` exposes `SqlClient.Connection.executeStream` but implements it as `Effect.dieMessage("executeStream not implemented")`. This was a real stub on an exported internal SQL client surface. Replaced with a functional stream and added a test that executes it.
- [x] Root dependency-boundary check failed because `apps/smithers-demo` imported `react` and `react-dom/client` without declaring `react` / `react-dom` in its own package manifest. Added direct dependencies to the app manifest.
- [x] `packages/agents/tests/agent-diagnostics.test.js` had an async test that only asserted a promise was returned, then left the diagnostics work running in the background. Fixed it to await the diagnostics report and assert its contents.
- [x] `packages/driver/src/child-process.js` could let a stale idle timer kill a process after stdout activity reset the watchdog. Added a generation guard and a Bun/macOS stdout-delivery grace for long CLI idle windows; targeted timeout tests now prove stdout activity keeps the process alive while hard timeouts still win.
- [x] `packages/engine` E2E tests exercised real CLI subprocesses and durable workflow paths but relied on Bun's 5s default test timeout. In a full package/workspace run they timed out despite passing with a realistic timeout budget. Made the package script explicit with a 60s timeout.
- [x] `packages/engine/tests/loop-until-reeval.test.jsx` passed alone but timed out inside the package/workspace run, which exposed non-isolated engine tests sharing process/runtime state under Bun's file concurrency. Made the engine package test script serial (`--max-concurrency=1`) so these integration tests execute in the same isolation mode they require.
- [x] `packages/engine/tests/deferred-contract.test.js` asserted a 120ms timer would still be waiting after a full workflow start, which is a wall-clock race under load. Increased the timer margin so the test validates pause/resume behavior instead of scheduler speed.
- [x] `packages/smithers/tests/e2e-helpers.js` spawned CLI E2E subprocesses without a timeout, so a hung CLI could block until Bun killed a dangling child. Added a bounded default timeout and stable SIGTERM exit mapping.
- [x] `packages/engine/tests/heartbeat-bounds.test.jsx` used a 30s explicit timeout for real 1MB heartbeat persistence and skipped cleanup on failure. Raised the timeout to the package budget and wrapped DB cleanup in `finally`.
- [ ] Skipped tests in `packages/time-travel/tests/rewindLock-concurrent.test.ts`, `packages/time-travel/tests/fork-recovery.test.js`, `packages/sandbox/tests/sandbox-isolation.test.js`, and the fault-injection suite are honest documented environment/feature gaps, not fake-green assertions. Keep them flagged as unproven unless their prerequisites are implemented.
- [ ] Broad 6LARP scan found many `return null` / `return []` paths in React marker components, parsers, optional resolvers, and agent event decoders. These are not automatically stubs, but only targeted tests prove specific behavior.

## Verification TODO

- [x] Run targeted DB tests covering `executeStream`.
- [x] Run targeted time-travel fork recovery tests covering rollback.
- [x] Run package-level typechecks for touched packages.
- [x] Run package-level tests for touched packages.
- [x] Run `apps/smithers-demo` tests and build after dependency-manifest fix.
- [x] Run package-level agents tests after fixing the unawaited diagnostics test and timeout watchdog.
- [x] Run full engine package after serializing the engine package script and fixing the timer/CLI harness races. `pnpm --filter @smithers-orchestrator/engine --config.verify-deps-before-run=false test` passed: 527 tests across 87 files.
- [x] Run broader root checks. Root preflight checks passed: `node scripts/check-single-effect-version.mjs`, `node scripts/check-dependency-boundaries.mjs`, and `node scripts/check-architecture-budget.mjs`.
- [x] Run a full recursive workspace test after fixes. `pnpm -r --workspace-concurrency=1 --config.verify-deps-before-run=false test` passed across 31 workspace projects. Notable remaining skips are documented above.
