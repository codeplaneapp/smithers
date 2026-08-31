# Phase 7 gate: sqlite-persistence-crash

Verdict: PASS

The real SQLite persistence and crash/restart suites all exit 0 from the clean
checkout at `20b32c6316`: `@smthrs/journal`, `@smthrs/run-store`,
`@smthrs/engine-store` (with its 9-case in-package fault matrix),
`@smthrs/time-travel`, and `@smthrs/testing` (with `RestartableEngine`), 1521
tests passed across 189 files with 0 failures. The end-to-end fault matrix under
`e2e/` ran its 18 declared cases inside the wall-time budget; every crash-family
case passed, and the one red test is case 22's terminal-redaction half, a
documented product gap outside this gate's scope (section 6).

This file supersedes the 2026-08-30 15:53 evidence taken at `9c464343f0` in
`migration/clean-checkout` (that directory no longer exists). Section 8 lists
what moved.

## 1. Environment

| Item | Value |
| --- | --- |
| Host | macOS 26.2 (build 25C56), Darwin 25.2.0, arm64 |
| Date | 2026-08-31 06:58 to 07:05 UTC (2026-08-30 23:58 to 2026-08-31 00:05 PT) |
| Node | v24.18.0 (`/Users/williamcory/.nvm/versions/node/v24.18.0/bin/node`); rc-contract floor is `>=22.19.0` |
| Bun | 1.4.0 (`bun --version`); not used, every suite here runs under Node because the durable engine refuses Bun |
| corepack / pnpm | 0.35.0 / 11.21.0 (selected by `packageManager: pnpm@11.21.0`) |
| vitest | 4.1.9 |
| jj | 0.39.0 at `/opt/homebrew/bin/jj` (fault cases 12 and 21 drive a real Jujutsu workspace) |
| git | 2.50.1 (Apple Git-155) |
| `SMITHERS_HOME` | unset for every invocation (`env -u SMITHERS_HOME`) |
| Host load | Other Phase 7 lanes ran at the same time in sibling checkouts (`tsc -p tsconfig.test.json`, `vitest run --reporter=verbose`, `smithers snapshots`, `pnpm --dir packages/std run build`, a `TelegramLive.test.ts` run) plus an `ollama runner`. 1-minute load averages sampled around each run: 11.08 before `journal`, 23.94 before and 83.45 after `engine-store`, 75.16 before and 55.68 after `time-travel`, 42.43 before and 46.23 after the e2e matrix. |

The load inflates durations relative to the superseded run (`engine-store`
101.66 s here against 61.81 s then) and did not produce a timeout or a failure.

## 2. Checkout

`/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-2`
(written as `<clean-checkout-2>` below), branch `v1/rc0-migration`, HEAD
`20b32c6316487497301db74ec70cbe951428ef53`. The `00-clean-install` gate created
it and verified both frozen installs. Package `exports` point at `src/*.ts`, so
no build step precedes these suites; no `dist/` exists in any package under test.
`git status --porcelain` was empty before the first run and after the last one,
so the suites left no residue in the tree, and `ps` shows no process from
`<clean-checkout-2>/e2e` surviving the matrix.

## 3. Package suites

Each suite ran alone, in this order, as
`env -u SMITHERS_HOME corepack pnpm exec vitest run` from its package directory
through `sqlite-persistence-crash-logs/run-suite.sh`, with stdout and stderr
captured to `<package>.log`. The package `test` script is `vitest`; `run` pins
one-shot mode. Each package's `vitest.config.ts` enables v8 coverage and
enforces its thresholds on every run, so exit 0 means the thresholds held.

| Package | Start (UTC) | End (UTC) | Exit | Test files | Tests | Duration |
| --- | --- | --- | --- | --- | --- | --- |
| `@smthrs/journal` | 06:58:41 | 06:58:48 | 0 | 20 passed (20) | 156 passed (156) | 5.60 s |
| `@smthrs/run-store` | 06:58:48 | 06:58:57 | 0 | 17 passed (17) | 131 passed (131) | 7.16 s |
| `@smthrs/testing` | 06:58:57 | 06:59:02 | 0 | 18 passed (18) | 123 passed, 2 skipped (125) | 3.54 s |
| `@smthrs/engine-store` | 06:59:12 | 07:00:56 | 0 | 100 passed (100) | 799 passed (799) | 101.66 s |
| `@smthrs/time-travel` | 07:01:11 | 07:01:53 | 0 | 34 passed (34) | 312 passed (312) | 40.33 s |

Totals: 189 test files, 1521 tests passed, 2 skipped, 0 failed.

Final summary lines, verbatim from the logs:

```
journal:      Test Files  20 passed (20)   / Tests  156 passed (156)
run-store:    Test Files  17 passed (17)   / Tests  131 passed (131)
testing:      Test Files  18 passed (18)   / Tests  123 passed | 2 skipped (125)
engine-store: Test Files  100 passed (100) / Tests  799 passed (799)
time-travel:  Test Files  34 passed (34)   / Tests  312 passed (312)
```

Coverage, from each log's `Coverage summary` block against the thresholds in
each `vitest.config.ts`:

| Package | Statements | Branches | Functions | Lines | Thresholds (stmts/branches/funcs/lines) |
| --- | --- | --- | --- | --- | --- |
| `journal` | 100% (595/595) | 100% (315/315) | 100% (184/184) | 100% (570/570) | 100/100/100/100 |
| `run-store` | 100% (457/457) | 100% (327/327) | 100% (142/142) | 100% (434/434) | 100/100/100/100 |
| `engine-store` | 100% (3517/3517) | 100% (1741/1741) | 100% (922/922) | 100% (3188/3188) | 100/100/100/100 |
| `time-travel` | 100% (1123/1123) | 100% (564/564) | 100% (296/296) | 100% (1045/1045) | 100/100/100/100 |
| `testing` | 90.59% | 75.19% | 90.46% | 91.82% | 89/73/89/90 |

The superseded evidence stated 100% coverage for every package. That was wrong
for `@smthrs/testing`, whose config enforced 89/73/89/90 at `9c464343f0` as
well; the package passes its own thresholds and never had a 100% gate.

## 4. Named crash suites, run alone

The suites the gate names individually were also run as single files with
`--coverage.enabled=false`, since one file cannot meet a whole-package
threshold. Every count below is already inside the package totals in section 3.

| Suite | Command (cwd) | Exit | Tests |
| --- | --- | --- | --- |
| In-package fault matrix | `packages/engine-store`: `vitest run test/FaultMatrix.test.ts --coverage.enabled=false` | 0 | 9 passed (9) |
| Interrupted park (new since `9c464343f0`) | `packages/engine-store`: `vitest run test/InterruptedSuspensionPark.test.ts --coverage.enabled=false` | 0 | 3 passed (3) |
| RestartableEngine harness | `packages/testing`: `vitest run test/RestartableEngine.test.ts --coverage.enabled=false` | 0 | 2 passed (2) |
| RestartableEngine consumer | `packages/testing`: `vitest run test/applied/MemoryEngineConformance.test.ts --coverage.enabled=false` | 0 | 15 passed (15) |

`RestartableEngine.test.ts` proves the harness itself: `restarts over the same
store and executes only the frontier` and `kill leaves the abandoned instance
running and unreleased` (the way `SIGKILL` abandons a durable owner).
`applied/MemoryEngineConformance.test.ts` is the conformance suite that drives
the harness's restart, kill, and killAndResume controls.
`InterruptedSuspensionPark.test.ts` arrived with the engine-park fix lane
(commits `05a1f78380`, `6644bfb1e6`, `d039eeac90`, merged as `6199b80c24`) and
pins that a shutdown interrupting a suspended round parks the run instead of
cancelling it.

## 5. End-to-end fault matrix (`e2e/`)

The matrix kills real operating-system processes with `SIGKILL`, resumes in a
fresh process against a SQLite file on disk (`harness/killResumeCase.ts`
creates a `mkdtemp` directory and opens `run.sqlite` in it), spawns the
product's own `smithers serve` from the bin `@smthrs/cli` declares
(`harness/serveProcess.ts`), and drives `@smthrs/time-travel` over a real
Jujutsu workspace. `e2e/vitest.config.ts` sets `fileParallelism: false` and a
180 s per-test budget.

Command, from `<clean-checkout-2>/e2e`:
`env -u SMITHERS_HOME node ci/runFaultSuite.ts --suite pr --results <log dir>/e2e-fault-results.json`
(the `test:faults` script). Start 07:02:22 UTC, end 07:04:42 UTC, exit 1. The
runner propagates vitest's exit code; the budget verdict itself passed:

```
[fault-budget] pr finished in 139.8s within perPRSuiteWallTimeMaxMs=900.0s (760.2s headroom)
```

Per-case outcomes, verbatim (`family` from `fault-matrix.json`):

| Case | Family | Outcome | Tests | Duration |
| --- | --- | --- | --- | --- |
| case01 kill-engine-mid-action | crash | pass | 1 | 34083 ms |
| case02 kill-sandbox-engine-alive | provider | pass | 1 | 729 ms |
| case03 restart-waiting-approval | crash | pass | 1 | 5136 ms |
| case04 restart-waiting-event | crash | pass | 1 | 3034 ms |
| case05 restart-waiting-timer | crash | pass | 1 | 7375 ms |
| case06 concurrent-resume-vs-sweep | crash | pass | 2 | 5935 ms |
| case08 inspector-never-idle | time-travel | pass | 1 | 1055 ms |
| case09 reconnect-durable-cursor | gateway | pass | 1 | 3891 ms |
| case11 frame-scrub-view-only | time-travel | pass | 1 | 1038 ms |
| case12 rewind-reverts-vcs | time-travel | pass | 1 | 1701 ms |
| case14 gateway-rpc-roundtrip | gateway | pass | 2 | 1348 ms |
| case15 ws-drop-reconnect | gateway | pass | 1 | 1891 ms |
| case16 n5-subscribers-bounded-memory | gateway | pass | 1 | 12964 ms |
| case21 jj-pointer-integrity | provider | pass | 2 | 902 ms |
| case22 secret-never-in-journal | safety | **fail** | 2 (1 failed) | 1864 ms |
| case25 approval-scope-denial | gateway | pass | 5 | 2495 ms |
| case31 real-engine-kill-resume | crash | pass | 1 | 31806 ms |
| case32 checkpoint-kill-resume | crash | pass | 2 | 884 ms |

Totals: 18 cases, 17 passed, 1 failed; 27 tests, 26 passed, 1 failed, 0
skipped, 0 incomplete. All seven crash-family cases (01, 03, 04, 05, 06, 31,
32) passed. Cases 12 and 21 ran against the real `jj` binary rather than
skipping.

## 6. The one red test: case 22, terminal half

Run alone to capture the assertion
(`corepack pnpm exec vitest run faults/case22-secret-never-in-journal.test.ts`,
07:05:07 to 07:05:12 UTC, exit 1):

```
 ❯ faults/case22-secret-never-in-journal.test.ts (2 tests | 1 failed) 2228ms
     × redacts the credential out of the operator's terminal 955ms
 FAIL  faults/case22-secret-never-in-journal.test.ts > case22 a secret never reaches the journal > redacts the credential out of the operator's terminal
AssertionError: expected '[00:05:12.441] INFO (#100): calling h…' not to contain 'sk-live-e2ecase22NEVERLOGTHIS'
 ❯ faults/case22-secret-never-in-journal.test.ts:113:30
```

Classification: a known product gap, not a persistence or crash defect, and
outside this gate's verdict.

- The persistence half passes: `redacts the credential out of every committed
  journal row` reads the SQLite file directly and finds no credential.
- The failing half asserts that rc.0 redacts a credential an action logs to the
  operator's terminal. rc.0 ships no redacting logger. `e2e/fault-gaps.md`
  (row 22) states the test is intentionally red as a plain failing test, not
  an `it.fails` and not a skip, and `scripts/repo-contract/fault-skips.test.mjs`
  refuses every way of making it green without the logger.
- rc-contract ruling R-12 makes case 22 a Phase 7 required parity test, so it
  must pass before the maintainer publishes. Owner: the Phase 5 redaction
  deliverable (rc-contract section 5.2). Root `BUILD.ts` lines 214 to 225 keep
  the `e2e-faults` CI job advisory (`continueOnError: true`, absent from
  `requiredJobs`) until that lands.
- No other Phase 7 evidence file owns this red: `scans.md` does not mention
  case 22. `fault-gaps.md` says the limitation is recorded on the
  known-limitations page; `grep -rn -i "redacting logger\|case 22\|case22"
  docs/pages` finds no such entry at this HEAD. Both are carry-forward items
  for the orchestrator, recorded here so the red is not lost between gates.

## 7. Real backends

- The durable package suites open SQLite through `@smthrs/database`
  `NodeDatabase.layer` over `@effect/sql-sqlite-node` and `node:sqlite`, with
  the real migration ladder applied before any store is used. No persistence
  is mocked.
- `packages/engine-store/src/test/TestStores.ts` `layer()` binds `SqlJournal`,
  `RunStore`, `AttemptStore`, `CacheStore`, and `PlanStore` to one private
  `:memory:` `node:sqlite` connection with the complete durable schema;
  `databaseAt(filename)` opens the same stores on a file. The in-package fault
  matrix (`FaultMatrix.test.ts`) runs over `TestStores.layer()`.
- File-backed on-disk databases (`mkdtemp` directories, `TestStores.databaseAt`
  or `NodeDatabase.layer({ filename })`) back the crash and restart suites. At
  this HEAD they are: `engine-store` (15 files) `CycleDetectionSql`,
  `DeferredRestartMatrix`, `DisasterRecovery`, `DurableWaitingRestart`,
  `HardKillReclaim`, `PlanSchedulerProduction`, `RacedParkResume`,
  `ReplayCorruptionClassification`, `RestoreDrill`, `Retention`,
  `RetentionFacade`, `RunCatalogCatchUp`, `SandboxedAction`,
  `UnregisteredFlowWarning`, `UnresolvedActionSettles`; `journal` (4)
  `JournalCompactionDurable`, `JournalDurable`, `JournalDurableRecovery`,
  `JournalFenceDurable`; `run-store` (2) `MigrationsDurableUpgrade`,
  `RunStoreFileFence.integration` (with a real child process,
  `run-store-file-fence-child.ts`); `time-travel` (5) `ForkLineage`,
  `ReplayDurability`, `SqlForkExecution`, `SqlTimeTravelStoreOperations`,
  `TimeTravelMigrations`, plus `RewindCrashRecovery.e2e`, `RewindInFlight.e2e`,
  and `TimeTravelRewind.e2e` through `RealTimeTravelHarness.ts`.
- The e2e crash cases kill a separate child process (`harness/engineChild.ts`,
  `harness/waitChild.ts`) with `SIGKILL` and resume against the same
  `run.sqlite` file in a fresh process; the gateway cases talk to a spawned
  `smithers serve` over a real socket with a real bearer credential.

## 8. Skips and deltas

The 2 skipped tests are both in `packages/testing/test/ParityManifest.test.ts`,
guarded by `it.skipIf(corpusRoot === undefined)`: they inventory an OpenCode
reference clone kept outside the repository (`../reference` or `reference/`).
No clone exists in this checkout, so the skip is the designed behavior and not
a persistence or crash-coverage gap. No other test in the five packages
skipped, and no e2e case skipped or reported incomplete.

Since the superseded run at `9c464343f0` (48 commits), the gate's inputs moved
as follows:

- `engine-store`: 99 files / 796 tests became 100 files / 799 tests. The new
  file is `test/InterruptedSuspensionPark.test.ts` (3 tests) and
  `src/internal/RunDriver.ts` changed with it (engine-park lane, merged
  `6199b80c24`).
- `e2e`: became a workspace member (`73cbf3ae6a`), its claim-race fixture was
  fixed to park through the runtime (`47aaf08792`), and the fault cases were
  kept out of the root test fan-out (`76c1b99413`). The superseded evidence
  did not run this matrix; this one does.
- `journal`, `run-store`, `time-travel`, `testing`: unchanged counts (156, 131,
  312, 123 + 2 skipped).

## 9. Raw logs

`sqlite-persistence-crash-logs/` beside this file: `env.txt`, `summary.tsv`
(label, start, end, exit, command for every run), `run-suite.sh`,
`journal.log`, `run-store.log`, `testing.log`, `engine-store.log`,
`time-travel.log`, `named-fault-matrix.log`, `named-interrupted-park.log`,
`named-restartable-engine.log`, `named-memory-engine-conformance.log`,
`e2e-faults.log`, `e2e-fault-results.json`, `e2e-case22.log`.

## Verdict

PASS. From the clean checkout at `20b32c6316`, the five SQLite persistence and
crash/restart packages exit 0 with 1521 tests passed across 189 files and every
coverage threshold held; the 9-case in-package fault matrix, the new 3-case
interrupted-park suite, and the RestartableEngine harness pass alone; and the
end-to-end fault matrix passes all seven crash-family cases and 17 of 18 cases
inside its 900 s budget. The single red test is case 22's terminal-redaction
half, a documented rc.0 product gap owned by the Phase 5 redaction deliverable
and required by rc-contract R-12 before publish; it is not a persistence or
crash defect and is carried forward to the orchestrator.
