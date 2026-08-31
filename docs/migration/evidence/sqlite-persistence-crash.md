# Phase 7 gate: sqlite-persistence-crash

Verdict: PASS

The real SQLite persistence and crash/restart suites all exit 0 from the clean
checkout at `cd14388ed7`: `@smthrs/journal`, `@smthrs/run-store`,
`@smthrs/engine-store` (with its 9-case in-package fault matrix),
`@smthrs/time-travel`, and `@smthrs/testing` (with `RestartableEngine`), 1543
tests passed across 191 files with 0 failures and every coverage threshold held.
The end-to-end fault matrix under `e2e/` ran its 18 declared cases inside the
wall-time budget; all seven crash-family cases passed, and the one red test is
case 22's terminal-redaction half, a documented rc.0 product gap outside this
gate's scope (section 6).

This file supersedes the 2026-08-31 00:08 PT evidence taken at `20b32c6316` in
`migration/clean-checkout-2` (that directory no longer exists). The superseded
file is kept beside this one as `sqlite-persistence-crash-prev-20b32c6316.md`
with its logs in `sqlite-persistence-crash-logs-prev-20b32c6316/`. Section 8
lists what moved.

## 1. Environment

| Item | Value |
| --- | --- |
| Host | macOS 26.2 (build 25C56), Darwin 25.2.0, arm64 |
| Date | 2026-08-31 11:59 to 12:09 UTC (2026-08-31 04:59 to 05:09 PT) |
| Node | v24.18.0 (`/Users/williamcory/.nvm/versions/node/v24.18.0/bin/node`); rc-contract section 1 floor is `>=22.19.0` |
| Bun | 1.4.0 (`bun --version`); not used, every suite here runs under Node because the durable engine refuses Bun |
| corepack / pnpm | 0.35.0 / 11.21.0 (selected by `packageManager: pnpm@11.21.0`) |
| vitest | 4.1.9 (`vitest/4.1.9 darwin-arm64 node-v24.18.0`) |
| jj | 0.39.0 at `/opt/homebrew/bin/jj` (fault cases 12 and 21 drive a real Jujutsu workspace) |
| git | 2.50.1 (Apple Git-155) |
| `SMITHERS_HOME` | unset in the calling shell and stripped from every invocation (`env -u SMITHERS_HOME`) |
| Host load | Other Phase 7 lanes ran at the same time, several of them inside this same checkout (an `examples` and a `packages/migrate` `vitest run`, `packages/build-cli` and `packages/cli` `tsc`, `smithers-build query //...`, `smithers list-runs`, and a `pnpm -r run build` that created `packages/*/dist/` between 12:02 and 12:05 UTC). 1-minute load averages, sampled before and after each run and recorded in `summary.tsv`: 20.23 before `journal`, 63.93 before and 71.91 after `engine-store`, 72.16 before and 62.44 after `time-travel`, 43.38 before and 83.38 after the e2e matrix. |

The load inflates durations relative to the superseded run (`engine-store`
128.68 s here against 101.66 s then; the e2e matrix 203.7 s against 139.8 s)
and did not produce a timeout or a failure.

## 2. Checkout

`/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4`
(written as `<clean-checkout-4>` below), branch `v1/rc0-migration`, HEAD
`cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba`, submodule `vendor/jj` at
`47589ada70c12b3e829b5c98ab32503abad49eac`. The `00-clean-install` gate created
it and verified both frozen installs. `git status --porcelain` printed 0 lines
before the first run and after the last one.

Package `exports` resolve to source (`packages/journal/package.json`:
`".": "./src/index.ts"`, `"./*": "./src/*.ts"`, and the same shape in every
package under test), so no build step precedes these suites and the suites
never read `dist/`. No `dist/` existed when the first suite started
(`env.txt`: `dist-dirs: 0`). A concurrent lane's `pnpm -r run build` created
`packages/{journal,run-store,engine-store,time-travel,testing}/dist/` while
`engine-store` and `time-travel` were running (directory mtimes 12:02:01 to
12:05:19 UTC). Those directories are gitignored and unreferenced by the
`src`-pointing `exports`, so they changed neither the tree status nor what the
suites exercised. `ps` shows no process under `<clean-checkout-4>/e2e` and no
`smithers serve`, `engineChild`, `waitChild`, or `run-store-file-fence-child`
surviving the runs.

## 3. Package suites

Each suite ran as the only vitest process this lane launched, in this order, as
`env -u SMITHERS_HOME corepack pnpm exec vitest run` from its package directory
through `sqlite-persistence-crash-logs/run-suite.sh`, with stdout and stderr
captured to `<package>.log`. The package `test` script is `vitest`; `run` pins
one-shot mode. Each package's `vitest.config.ts` enables v8 coverage and
enforces its thresholds on every run, so exit 0 means the thresholds held.
`engine-store` and `time-travel` scope their coverage directory to the process,
so the concurrent lanes' vitest runs in other packages could not clobber them.

| Package | Start (UTC) | End (UTC) | Exit | Test files | Tests | Duration |
| --- | --- | --- | --- | --- | --- | --- |
| `@smthrs/journal` | 11:59:39 | 11:59:49 | 0 | 20 passed (20) | 156 passed (156) | 7.91 s |
| `@smthrs/run-store` | 11:59:49 | 12:00:04 | 0 | 17 passed (17) | 131 passed (131) | 12.24 s |
| `@smthrs/testing` | 12:00:04 | 12:00:16 | 0 | 18 passed (18) | 123 passed, 2 skipped (125) | 7.99 s |
| `@smthrs/engine-store` | 12:00:54 | 12:03:05 | 0 | 102 passed (102) | 821 passed (821) | 128.68 s |
| `@smthrs/time-travel` | 12:03:10 | 12:03:57 | 0 | 34 passed (34) | 312 passed (312) | 44.31 s |

Totals: 191 test files, 1543 tests passed, 2 skipped, 0 failed.

Final summary lines, verbatim from the logs:

```
journal:      Test Files  20 passed (20)   / Tests  156 passed (156)
run-store:    Test Files  17 passed (17)   / Tests  131 passed (131)
testing:      Test Files  18 passed (18)   / Tests  123 passed | 2 skipped (125)
engine-store: Test Files  102 passed (102) / Tests  821 passed (821)
time-travel:  Test Files  34 passed (34)   / Tests  312 passed (312)
```

Coverage, from each log's `Coverage summary` block against the thresholds in
each `vitest.config.ts`:

| Package | Statements | Branches | Functions | Lines | Thresholds (stmts/branches/funcs/lines) |
| --- | --- | --- | --- | --- | --- |
| `journal` | 100% (595/595) | 100% (315/315) | 100% (184/184) | 100% (570/570) | 100/100/100/100 |
| `run-store` | 100% (457/457) | 100% (327/327) | 100% (142/142) | 100% (434/434) | 100/100/100/100 |
| `engine-store` | 100% (3566/3566) | 100% (1786/1786) | 100% (933/933) | 100% (3232/3232) | 100/100/100/100 |
| `time-travel` | 100% (1123/1123) | 100% (564/564) | 100% (296/296) | 100% (1045/1045) | 100/100/100/100 |
| `testing` | 90.59% (1349/1489) | 75.19% (570/758) | 90.46% (484/535) | 91.82% (1235/1345) | 89/73/89/90 |

`engine-store` grew by 49 statements, 45 branches, 11 functions, and 44 lines
since `20b32c6316` (`src/internal/ExitEncoding.ts` and the `RunDriver.ts`
change that uses it) and stays at 100% on every axis.

## 4. Named crash suites, run alone

The suites the gate names individually were also run as single files with
`--coverage.enabled=false`, since one file cannot meet a whole-package
threshold. Every count below is already inside the package totals in section 3.

| Suite | Command (cwd) | Exit | Tests |
| --- | --- | --- | --- |
| In-package fault matrix | `packages/engine-store`: `vitest run test/FaultMatrix.test.ts --coverage.enabled=false` | 0 | 9 passed (9) |
| Interrupted park | `packages/engine-store`: `vitest run test/InterruptedSuspensionPark.test.ts --coverage.enabled=false` | 0 | 3 passed (3) |
| Unencodable settlement (new since `20b32c6316`) | `packages/engine-store`: `vitest run test/UnencodableSettlement.test.ts --coverage.enabled=false` | 0 | 2 passed (2) |
| Hard-kill reclaim | `packages/engine-store`: `vitest run test/HardKillReclaim.test.ts --coverage.enabled=false` | 0 | 5 passed (5) |
| RestartableEngine harness | `packages/testing`: `vitest run test/RestartableEngine.test.ts --coverage.enabled=false` | 0 | 2 passed (2) |
| RestartableEngine consumer | `packages/testing`: `vitest run test/applied/MemoryEngineConformance.test.ts --coverage.enabled=false` | 0 | 15 passed (15) |

`RestartableEngine.test.ts` proves the harness itself: `restarts over the same
store and executes only the frontier` and `kill leaves the abandoned instance
running and unreleased` (the way `SIGKILL` abandons a durable owner).
`applied/MemoryEngineConformance.test.ts` is the conformance suite that drives
the harness's restart, kill, and killAndResume controls.
`UnencodableSettlement.test.ts` arrived with `e44159b9ef` (`fix(engine-store):
persist a failed run whose exit cause the flow codec rejects`) and pins, over
`TestStores.layer()`, that such a run settles `failed` with the cause projected
onto its row and that a waiting caller receives the projected failure rather
than a suspension. `HardKillReclaim.test.ts` runs over a file-backed database
and covers reclaim of a run whose owner died without releasing its lease.

## 5. End-to-end fault matrix (`e2e/`)

The matrix kills real operating-system processes with `SIGKILL`, resumes in a
fresh process against a SQLite file on disk (`harness/killResumeCase.ts`
creates a `mkdtemp` directory and opens `run.sqlite` in it), spawns the
product's own `smithers serve` from the bin `@smthrs/cli` declares
(`harness/serveProcess.ts`), and drives `@smthrs/time-travel` over a real
Jujutsu workspace. `e2e/vitest.config.ts` sets `fileParallelism: false` and a
180 s per-test budget.

Command, from `<clean-checkout-4>/e2e`:
`env -u SMITHERS_HOME node ci/runFaultSuite.ts --suite pr --results <log dir>/e2e-fault-results.json`
(the `test:faults` script). Start 12:04:51 UTC, end 12:08:14 UTC, exit 1. The
runner propagates vitest's exit code; the budget verdict itself passed:

```
[fault-budget] pr finished in 203.7s within perPRSuiteWallTimeMaxMs=900.0s (696.3s headroom)
```

Per-case outcomes, verbatim from `e2e-fault-results.json` (`family` joined from
`fault-matrix.json`):

| Case | Family | Outcome | Tests | Duration |
| --- | --- | --- | --- | --- |
| case01 kill-engine-mid-action | crash | pass | 1 | 36910 ms |
| case02 kill-sandbox-engine-alive | provider | pass | 1 | 1052 ms |
| case03 restart-waiting-approval | crash | pass | 1 | 4636 ms |
| case04 restart-waiting-event | crash | pass | 1 | 7341 ms |
| case05 restart-waiting-timer | crash | pass | 1 | 10646 ms |
| case06 concurrent-resume-vs-sweep | crash | pass | 2 | 5651 ms |
| case08 inspector-never-idle | time-travel | pass | 1 | 1591 ms |
| case09 reconnect-durable-cursor | gateway | pass | 1 | 8220 ms |
| case11 frame-scrub-view-only | time-travel | pass | 1 | 2535 ms |
| case12 rewind-reverts-vcs | time-travel | pass | 1 | 2067 ms |
| case14 gateway-rpc-roundtrip | gateway | pass | 2 | 7074 ms |
| case15 ws-drop-reconnect | gateway | pass | 1 | 6470 ms |
| case16 n5-subscribers-bounded-memory | gateway | pass | 1 | 18389 ms |
| case21 jj-pointer-integrity | provider | pass | 2 | 818 ms |
| case22 secret-never-in-journal | safety | **fail** | 2 (1 failed) | 2172 ms |
| case25 approval-scope-denial | gateway | pass | 5 | 2604 ms |
| case31 real-engine-kill-resume | crash | pass | 1 | 36067 ms |
| case32 checkpoint-kill-resume | crash | pass | 2 | 1723 ms |

Totals: 18 cases, 17 passed, 1 failed; 27 tests, 26 passed, 1 failed, 0
skipped, 0 incomplete. All seven crash-family cases (01, 03, 04, 05, 06, 31,
32) passed. Cases 12 and 21 ran against the real `jj` binary rather than
skipping.

## 6. The one red test: case 22, terminal half

Run alone to capture the assertion
(`corepack pnpm exec vitest run faults/case22-secret-never-in-journal.test.ts`,
12:08:26 to 12:08:39 UTC, exit 1):

```
 ❯ faults/case22-secret-never-in-journal.test.ts (2 tests | 1 failed) 7727ms
     × redacts the credential out of the operator's terminal 4010ms
 FAIL  faults/case22-secret-never-in-journal.test.ts > case22 a secret never reaches the journal > redacts the credential out of the operator's terminal
AssertionError: expected '[05:08:38.930] INFO (#100): calling h…' not to contain 'sk-live-e2ecase22NEVERLOGTHIS'
+ [05:08:38.930] INFO (#100): calling https://example.test/deploy with Bearer sk-live-e2ecase22NEVERLOGTHIS {
+   runId: 'case22-terminal',
```

Classification: a known product gap, not a persistence or crash defect, and
outside this gate's verdict.

- The persistence half passes: `redacts the credential out of every committed
  journal row` reads the SQLite file directly and finds no credential.
- The failing half asserts that rc.0 redacts a credential an action logs to the
  operator's terminal. rc.0 ships no redacting logger. `e2e/fault-gaps.md`
  (row 22) states the test is intentionally red as a plain failing test, not
  an `it.fails` and not a skip, and `scripts/repo-contract/fault-skips.test.mjs`
  (line 58 onward) refuses every way of making it green without the logger.
- rc-contract ruling R-12 makes case 22 a Phase 7 required parity test, so it
  must pass before the maintainer publishes. Owner: the Phase 5 redaction
  deliverable (rc-contract section 5.2). Root `BUILD.ts` lines 213 to 225 keep
  the `e2e-faults` CI job advisory (`continueOnError: true`, absent from
  `requiredJobs`) until that lands.
- The superseded evidence recorded that no known-limitations entry existed at
  `20b32c6316`. That carry-forward is closed at this HEAD: `688bc1bc2a`
  (`docs(release): record the terminal credential-redaction limitation R-12
  leaves shipped`) added
  `docs/pages/release/known-limitations.md#credential-redaction-in-logs`
  (line 133), the same paragraph in `docs/migration/rc-contract.md` (line
  359), and the regenerated llms bundles. The remaining carry-forward is the
  red test itself, which R-12 requires green before publish.

## 7. Real backends

- The durable package suites open SQLite through `@smthrs/database`
  `NodeDatabase.layer` over `@effect/sql-sqlite-node` and `node:sqlite`, with
  the real migration ladder applied before any store is used. No persistence
  is mocked.
- `packages/engine-store/src/test/TestStores.ts` `layer()` binds `SqlJournal`,
  `RunStore`, `AttemptStore`, `CacheStore`, and `PlanStore` to one private
  `:memory:` `node:sqlite` connection with the complete durable schema;
  `databaseAt(filename)` opens the same stores on a file. The in-package fault
  matrix (`FaultMatrix.test.ts`) and the new `UnencodableSettlement.test.ts`
  run over `TestStores.layer()`.
- File-backed on-disk databases (`mkdtemp` directories, `TestStores.databaseAt`
  or `NodeDatabase.layer({ filename })`) back the crash and restart suites. The
  set is the one the superseded evidence enumerated, unchanged by the 20
  commits since: `engine-store` `CycleDetectionSql`, `DeferredRestartMatrix`,
  `DisasterRecovery`, `DurableWaitingRestart`, `HardKillReclaim`,
  `PlanSchedulerProduction`, `RacedParkResume`,
  `ReplayCorruptionClassification`, `RestoreDrill`, `Retention`,
  `RetentionFacade`, `RunCatalogCatchUp`, `SandboxedAction`,
  `UnregisteredFlowWarning`, `UnresolvedActionSettles`; `journal`
  `JournalCompactionDurable`, `JournalDurable`, `JournalDurableRecovery`,
  `JournalFenceDurable`; `run-store` `MigrationsDurableUpgrade`,
  `RunStoreFileFence.integration` (with a real child process,
  `run-store-file-fence-child.ts`); `time-travel` `ForkLineage`,
  `ReplayDurability`, `SqlForkExecution`, `SqlTimeTravelStoreOperations`,
  `TimeTravelMigrations`, plus `RewindCrashRecovery.e2e`, `RewindInFlight.e2e`,
  and `TimeTravelRewind.e2e` through `RealTimeTravelHarness.ts`. The two new
  `engine-store` files are a pure codec suite (`ExitEncoding.test.ts`, no
  database) and a `TestStores.layer()` suite (`UnencodableSettlement.test.ts`).
- The e2e crash cases kill a separate child process (`harness/engineChild.ts`,
  `harness/waitChild.ts`) with `SIGKILL` and resume against the same
  `run.sqlite` file in a fresh process; the gateway cases talk to a spawned
  `smithers serve` over a real socket with a real bearer credential.

## 8. Skips and deltas

The 2 skipped tests are both in `packages/testing/test/ParityManifest.test.ts`,
guarded by `it.skipIf(corpusRoot === undefined)` (line 82): they inventory an
OpenCode reference clone kept outside the repository. No clone exists in this
checkout, so the skip is the designed behavior and not a persistence or
crash-coverage gap. No other test in the five packages skipped, and no e2e case
skipped or reported incomplete.

Since the superseded run at `20b32c6316` (20 commits), the gate's inputs moved
as follows (`git log 20b32c6316..cd14388ed7` over the packages under test and
`e2e/` lists exactly three commits):

- `engine-store`: 100 files / 799 tests became 102 files / 821 tests. The new
  files are `test/ExitEncoding.test.ts` (20 tests) and
  `test/UnencodableSettlement.test.ts` (2 tests), with
  `src/internal/ExitEncoding.ts` (new) and `src/internal/RunDriver.ts` changed
  alongside them (`e44159b9ef`, the engine-failed-persist fix lane).
- `testing`: `050a30f89f` moved `vitest` and `@effect/vitest` from
  `dependencies` to optional `peerDependencies`; both remain
  `devDependencies`, so the suite still runs in the workspace. Counts are
  unchanged (123 + 2 skipped).
- `e2e`: `688bc1bc2a` edited `fault-gaps.md` row 22 to name the new
  known-limitations anchor. No test file changed; counts are unchanged
  (18 cases, 27 tests).
- `journal`, `run-store`, `time-travel`: no commits; counts unchanged (156,
  131, 312).

## 9. Raw logs

`sqlite-persistence-crash-logs/` beside this file: `env.txt`, `summary.tsv`
(label, start, end, exit, command, load average before, load average after,
for every run), `run-suite.sh`, `journal.log`, `run-store.log`, `testing.log`,
`engine-store.log`, `time-travel.log`, `named-fault-matrix.log`,
`named-interrupted-park.log`, `named-unencodable-settlement.log`,
`named-hard-kill-reclaim.log`, `named-restartable-engine.log`,
`named-memory-engine-conformance.log`, `e2e-faults.log`,
`e2e-fault-results.json`, `e2e-case22.log`.

## Verdict

PASS. From the clean checkout at `cd14388ed7`, the five SQLite persistence and
crash/restart packages exit 0 with 1543 tests passed across 191 files and every
coverage threshold held; the 9-case in-package fault matrix, the 3-case
interrupted-park suite, the new 2-case unencodable-settlement suite, the 5-case
hard-kill reclaim suite, and the RestartableEngine harness pass alone; and the
end-to-end fault matrix passes all seven crash-family cases and 17 of 18 cases
inside its 900 s budget. The single red test is case 22's terminal-redaction
half, a documented rc.0 product gap (now recorded on the known-limitations
page) owned by the Phase 5 redaction deliverable and required by rc-contract
R-12 before publish; it is not a persistence or crash defect and is carried
forward to the orchestrator.
