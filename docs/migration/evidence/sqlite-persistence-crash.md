# Phase 7 gate: sqlite-persistence-crash

Verdict: PASS

Real SQLite persistence and crash/restart suites for the storage ladder and the restart harness: `@smthrs/journal`, `@smthrs/run-store`, `@smthrs/engine-store` (includes the fault matrix), `@smthrs/time-travel`, and `@smthrs/testing` (includes `RestartableEngine`). Every suite passed with zero failures.

## Environment

| Item | Value |
| --- | --- |
| Host | macOS arm64 (Darwin 25.2.0) |
| Node | v24.18.0 (above the rc.0 floor of 22.19.0) |
| Bun | 1.4.0 (not used by these suites; vitest runs under Node) |
| pnpm (via corepack 0.35.0) | 11.21.0 |
| vitest | 4.1.9 |
| Date | 2026-08-30 |

## Checkout

Clean checkout at `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout`, branch `v1/rc0-migration`, HEAD `9c464343f0cfada6aa36f0a08144ed7cf1f0ce14`. Frozen installs were verified by the `00-clean-install` gate. `git status --porcelain` is empty after all runs, so the suites left no residue in the tree.

## Commands and results

Each suite ran as `corepack pnpm exec vitest run` from its package directory, sequentially, output captured to a log. The package `test` script is `vitest`; `run` pins one-shot mode. Coverage is enabled by each package's vitest config and reported v8 coverage at 100% statements, branches, functions, and lines for every package below.

| Package | Command (cwd) | Exit | Test files | Tests | Duration |
| --- | --- | --- | --- | --- | --- |
| `@smthrs/journal` | `packages/journal` | 0 | 20 passed (20) | 156 passed (156) | 2.50s |
| `@smthrs/run-store` | `packages/run-store` | 0 | 17 passed (17) | 131 passed (131) | 2.58s |
| `@smthrs/engine-store` | `packages/engine-store` | 0 | 99 passed (99) | 796 passed (796) | 61.81s |
| `@smthrs/time-travel` | `packages/time-travel` | 0 | 34 passed (34) | 312 passed (312) | 36.17s |
| `@smthrs/testing` | `packages/testing` | 0 | 18 passed (18) | 123 passed, 2 skipped (125) | 2.36s |

Totals: 188 test files, 1518 tests passed, 2 skipped, 0 failed.

Final summary lines, verbatim from the logs:

```
journal:      Test Files  20 passed (20) / Tests  156 passed (156)
run-store:    Test Files  17 passed (17) / Tests  131 passed (131)
engine-store: Test Files  99 passed (99) / Tests  796 passed (796)
time-travel:  Test Files  34 passed (34) / Tests  312 passed (312)
testing:      Test Files  18 passed (18) / Tests  123 passed | 2 skipped (125)
```

Run timeline (UTC): journal 22:49:25 to 22:49:28, run-store 22:49:28 to 22:49:31, engine-store 22:49:31 to 22:50:34, time-travel 22:50:34 to 22:51:11, testing 22:51:11 to 22:51:15, all on 2026-08-30. Logs: `/private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/sqlite-gate/<package>.log`.

## Named-suite counts

The two suites the gate names individually were also run alone (same commands with the file argument and `--coverage.enabled=false`, since a single-file run cannot meet the whole-package coverage threshold):

| Suite | Command | Exit | Tests |
| --- | --- | --- | --- |
| Fault matrix | `packages/engine-store`: `vitest run test/FaultMatrix.test.ts` | 0 | 9 passed (9) |
| RestartableEngine | `packages/testing`: `vitest run test/RestartableEngine.test.ts` | 0 | 2 passed (2) |
| RestartableEngine consumer | `packages/testing`: `vitest run test/applied/MemoryEngineConformance.test.ts` | 0 | 15 passed (15) |

`RestartableEngine.test.ts` proves the harness itself (restart closes the outgoing scope, kill abandons it the way SIGKILL abandons a durable owner). `applied/MemoryEngineConformance.test.ts` is the conformance suite that drives the harness's restart, kill, and killAndResume controls. Both counts are inside the 125-test `@smthrs/testing` package run above.

## Real backends

- The durable suites open SQLite through `@smthrs/database` `NodeDatabase.layer` over `@effect/sql-sqlite-node` and `node:sqlite`, with the real migration ladder applied. No mocked persistence.
- File-backed on-disk databases (mkdtemp directories, `TestStores.layerAt(filename)` or `NodeDatabase` with a file path) back the crash/restart suites: in `engine-store` these are `DeferredRestartMatrix`, `DurableWaitingRestart`, `HardKillReclaim`, `DisasterRecovery`, `RestoreDrill`, `RacedParkResume`, `Retention`, `UnresolvedActionSettles`, `CycleDetectionSql`, `UnregisteredFlowWarning`, `PlanSchedulerProduction`, `ReplayCorruptionClassification`, `RunCatalogCatchUp`, and `SandboxedAction` (14 files); in `journal` they are `JournalDurable`, `JournalDurableRecovery`, `JournalFenceDurable`, and `JournalCompactionDurable`; in `run-store` they are `RunStoreFileFence.integration` (with a real child process, `run-store-file-fence-child.ts`) and `MigrationsDurableUpgrade`; in `time-travel` they are `ForkLineage`, `SqlForkExecution`, `SqlTimeTravelStoreOperations`, `ReplayDurability`, and `TimeTravelMigrations`, plus the `RewindCrashRecovery.e2e`, `RewindInFlight.e2e`, and `TimeTravelRewind.e2e` suites through `RealTimeTravelHarness.ts`.
- `FaultMatrix.test.ts` runs over `TestStores.layer()`, which binds journal, run-store, step-cache, and engine-store to one private in-memory SQLite connection with the complete durable schema and migrations. It is real `node:sqlite`, not a map-backed double.

## Skips

The 2 skipped tests are both in `packages/testing/test/ParityManifest.test.ts` and are guarded by `it.skipIf(corpusRoot === undefined)`: they inventory an OpenCode reference clone that the canonical layout keeps outside the repository (`../reference` or `reference/`). The test file documents that corpus-dependent suites skip in worktrees and CI when no clone is present. This clean checkout has no clone, so the skip is the designed behavior and is not a persistence or crash-coverage gap. No other test in the five packages skipped.

## Verdict

PASS. All five suites exit 0 from the clean checkout at `9c464343f0`: 1518 tests passed across 188 files, including the 9-case fault matrix and the RestartableEngine harness, with 100% v8 coverage in every package and only the two documented corpus-absent skips.
