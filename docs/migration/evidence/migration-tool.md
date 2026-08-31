# Phase 7 gate: migration-tool

Verdict: PASS

PLAN Phase 7 line: "migration workflow tests against representative 0.x projects."

This run validates `v1/rc0-migration` at `cd14388ed7` from the clean checkout `clean-checkout-4`. It supersedes the 2026-08-31 07:09Z run at `20b32c6316` (evidence preserved under `migration-tool-logs/prior-run-20b32c6316/`) and the 2026-08-30 run at `9c464343f0` (`migration-tool-logs/prior-run-9c464343f0/`). Every log this document cites is under `migration-tool-logs/` beside it. `git diff --stat 20b32c6316..cd14388ed7 -- packages/migrate flows` is empty; the commits between the two runs touched `packages/cli/src/{Command,bin}.ts` and its tests, so the `smithers migrate` verb path is what changed and what this run re-exercises.

## Environment

| Item | Value |
| --- | --- |
| Checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4` at `cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba` (`v1/rc0-migration`, the same commit `/Users/williamcory/smithers` has checked out), submodule `vendor/jj` at `47589ada7`; `git status --porcelain` empty at the start (11:59Z) and at the end (12:14Z) of this gate |
| Host | macOS Darwin 25.2.0 arm64 |
| Node | v24.18.0 |
| Bun | 1.4.0 |
| pnpm (corepack) | 11.21.0 |
| jj | 0.39.0 on PATH, so the jj checkpoint test ran |
| Date | 2026-08-31 (11:59Z to 12:14Z) |
| Credentials | `SMITHERS_MIGRATE_SEAT` unset, `ANTHROPIC_API_KEY` unset, `OPENROUTER_API_KEY` unset, `OPENAI_API_KEY` set but unused: the live suite keys off `SMITHERS_MIGRATE_SEAT` and never picks a model on its own |
| Plue | `/Users/williamcory/plue` at `664c95c609`; `lsof` on `.smithers/smithers.db`, `-wal`, `-shm` returned nothing before the copy, before the runs, and after them (no live 0.x writer) |
| Load | 1-minute load average 9.8 at the start, 28 when the vitest suite started, 49.9 when the pack test started, 40 to 63 during the Plue plan run. Other Phase 7 lanes ran in the same checkout at the same time and built `packages/*/dist` between 12:05Z and 12:10Z; their side effects are called out where they touched this gate. |

## 1. Package test suite (`//packages/migrate:test`)

`corepack pnpm exec smithers-build query '//packages/migrate/...'` lists `//packages/migrate:test` (`Vitest`) beside `check`, `circular`, `docs`, `fmt`, `lib`, and `lint`, so the workspace-graph CI job runs this suite.

Command, from `<clean-checkout>/packages/migrate`:

```sh
corepack pnpm exec vitest run
```

This is the package's own `test` script (`vitest`) in one-shot mode. The config enables v8 coverage with 70% thresholds on every metric and excludes `test/fixtures/**`, so the fixtures' own 0.x test files are scanner input, not collected tests. Log: `vitest.log`.

| Result | Value |
| --- | --- |
| Exit code | 0 |
| Test files | 28 passed, 1 skipped (29) |
| Tests | 374 passed, 6 skipped (380) |
| Duration | 67.43 s |
| Coverage | statements 92.5%, branches 81.79%, functions 94.35%, lines 95.54% (thresholds 70/70/70/70) |

A second run with `--reporter=verbose --coverage.enabled=false` (log: `vitest-verbose.log`, exit 0, same 374/6 counts, 71.93 s) names every skipped test:

| Skipped test | Reason |
| --- | --- |
| `test/flow/MigrateFlow.live.e2e.test.ts`, 3 tests (the 1 skipped file): "migrates a single-file JSX project through the bin", "records what a single-file project could not settle", "refuses what it cannot translate in a multi-workflow pack" | Printed by the test: "no model credentials: set SMITHERS_MIGRATE_SEAT to a provider:model seat and that provider's key". The tool hard-codes no model, so the suite refuses to spend money on one it picked itself. Operator-owned spend; environmental. |
| `test/Generated.test.ts` > "matches what the old checkout generates today" | `/Users/williamcory/smithers/packages/smithers/package.json` does not exist: `~/smithers` is the v1 tree, so the committed `FacadeExports.ts` catalog cannot be regenerated from a 0.x checkout here. The committed-catalog assertions in the same file ran and passed. Environmental. |
| `test/PlueGolden.test.ts` > "is skipped because the pack is not on this machine" | The placeholder branch. Plue IS present, so the real branch ran: it scanned `/Users/williamcory/plue/.smithers` read only, asserted the walk never enters `executions/` or `.worktrees/`, and resolved every imported name, every inventoried construct, and every component prop against the catalog. Correct branch. |
| `test/flow/Checkpoint.test.ts` > "is skipped because `jj` is not on PATH" | The placeholder branch. `jj` IS on PATH, so the real jj checkpoint test ran. Correct branch. |

The 29 files are `test/{Checks,Dependencies,Detect,Docs,Generated,Inventory,Mapping,MigratedFixture,PlueGolden,PromptHints,Report,RunState,Scan,Units,ZodSchemaHints}.test.ts` and `test/flow/{Archive,Bin,Checkpoint,Command,Contract,Dependencies,Finish,Gate,Layers,MigrateFlow.dryrun,MigrateFlow.live.e2e,MigrateFlow.scripted,Transform,Verify}.test.ts`. They run over the representative 0.x fixtures under `packages/migrate/test/fixtures`, each a byte-for-byte copy with a `FIXTURE.md` naming its origin commit: `jsx-single` (`~/smithers` at `cfb570f193`, 0.35.0), `plue-pack`, `batch-issues`, and `mixed-api` (Plue at `2db1ecff21`), `persisted-db` (`jsx-single` plus authored run state, with the database built at test time from verbatim 0.x `CREATE TABLE` statements), and `jsx-single.migrated` (the hand-written 1.0 output the deterministic checks run against). Every suite works on per-test temporary copies (`copyFixture`); the `Bin` suite spawns an esbuild bundle of the real `bin.ts` as a process. Nothing in the suite writes to a committed fixture or to a real project.

## 2. The `migrate-smithers-v1` fixture through the real detector and the real CLI (`flows/pack.test.mjs`)

`flows/migrate-smithers-v1/test/fixtures/smithers-0x-hello` is the migration flow's own 0.x fixture. `node --test flows/pack.test.mjs` runs it through `Detect.scan` and through `packages/cli/bin/smithers.mjs` in a detached copy under the system temp directory, and asserts `packages/cli/dist` is absent so the spawns run `src/`.

Command, from the clean checkout root, with `packages/cli/dist` absent (the log records the check). Log: `flows-pack-test.log`.

```sh
node --test flows/pack.test.mjs
```

| Result | Value |
| --- | --- |
| Exit code | 0 |
| Tests | 73 pass, 0 fail, 0 skipped (7 suites), 67.3 s under load |
| 0.x fixture checks | "is detected as a Smithers 0.x project by the migrate detector", "carries the 0.x CLI verbs its package scripts invoke", "holds no 0.x run state, so the migration gate has nothing to refuse" |
| Real CLI checks | "prints the section 6 notice the first time a command runs in it" (5.7 s), "passes the migrate verb's 0.x run gate, having no run state to refuse" (3.1 s), "is a project the migration planner reads as 0.x work, not an empty directory" (4.2 s) |

Unlike the prior run, no scratch clone was needed: the concurrent `packages/cli/dist` build landed at 12:08:34Z, after this suite finished at 12:01:16Z.

## 3. The `smithers migrate` verb over fixture copies (working-tree CLI)

Fixture copies were placed in the session scratchpad (never the committed fixtures) and removed afterwards. Commands ran from the clean checkout root through `corepack pnpm exec smithers`, which is `packages/cli/bin/smithers.mjs`; `packages/cli/dist` was absent for the whole section (12:02:33Z to 12:03:58Z; the log records the check, and the concurrent build wrote `dist` at 12:08:34Z), so every invocation ran `src/bin.ts` through Node type stripping. The `persisted-db` database was built with the fixture's own `node make-db.mjs <target>` (45,056 bytes; `run-live` running, `run-parked` waiting-quota, `run-finished`, `run-failed`; 3 schema-migration rows, confirmed by a read-only `node:sqlite` query before the runs). Log: `cli-migrate-fixtures.log`. Every tree was sha256-hashed file by file before and after; the diff excludes only the report directory.

| Command | Exit | Result |
| --- | --- | --- |
| `smithers migrate <jsx-single copy>` (plan) | 0 | "Units: 3 planned, 0 migrated, 0 failed, 0 blocked. Constructs: 11 rows across 7 mapping decisions. Run state: clean." Wrote `.smithers-migrate/report.{md,json}` and nothing else (hash diff outside the report directory: empty). Report preserved at `reports/jsx-single/`. |
| `smithers --quiet migrate --scan <jsx-single copy>` | 0 | Zero bytes changed anywhere, report directory included. |
| `smithers migrate --apply <persisted-db copy>` | 3 | "This project still holds Smithers 0.x run state (blocked). Finish, archive, or discard it, then rerun with --acknowledge-run-state." plus the three operator instructions. Zero bytes changed. `--apply` was passed only here, only against a scratch copy of an authored fixture, and it was refused before the first unit. |
| `smithers migrate <persisted-db copy>` (plan) | 0 | "Run state: blocked." Report lists `.smithers/smithers.db` readable, 3 migrations, live `run-live`, parked `run-parked`, and the three instructions. Nothing changed outside `.smithers-migrate/`. Report preserved at `reports/persisted-db/`. |
| `cd <persisted-db copy> && smithers migrate --report-dir .smithers-migrate-cwd` (plan, no path, the documented operator spelling) | 0 | Printed the section 6 notice once on stderr ("Found Smithers 0.x state at .../.smithers. 1.0.0-rc.0 does not load, resume, or migrate 0.x run databases ... See https://smithers.sh/migration/1.0#run-data"), then the same blocked plan. The hash diff shows four new files: the two report files and `.flows/control.db`, `.flows/engine.db`. See observation 2. |

## 4. Dry run over a copy of the Plue pack

The real tree at `/Users/williamcory/plue/.smithers` was never a write target and `--apply` was never passed against it or the copy. The pack was cloned whole (APFS clonefile; log: `plue-copy.log`):

```sh
cp -Rc /Users/williamcory/plue/.smithers <S>/phase7/plue-pack-copy   # real 130.68 s, exit 0
```

Completeness: 170,482 paths and 4.2 GB in both trees (`find | wc -l`, `du -sh`), including `smithers.db` (46.8 MB), `executions/`, `node_modules`, and `workflows/`. `smithers.db`, `smithers.db-wal`, and `smithers.db-shm` hash identical (sha256 `976c4af4...`, `e3b0c442...` the empty-file hash, `fd4c9fda...`) between the original and the copy, before and after the copy. Free disk stayed at 12 GiB because the clone shares blocks.

Both runs below are in `plue-dryrun.log`, which also records the marker sweeps and the hashes.

### 4a. The `smithers migrate` verb over the copy

```sh
corepack pnpm exec smithers migrate --report-dir .smithers-migrate-cli <S>/phase7/plue-pack-copy
```

Exit 1 in 14.37 s (stdout `plue-cli-plan.out`, empty; stderr `plue-cli-plan.err`). This ran `src/bin.ts`: it ended by 12:05:07Z and the concurrent `packages/cli/dist` appeared at 12:08:34Z. The verb's section 6 pre-check (`Legacy.refusal` over `Project.legacyDatabases`, the `<root>/smithers.db` walk that matches the 0.x default location) fired before the flow:

```
Refusing to migrate: this project still holds Smithers 0.x run state.
  <copy>/smithers.db:
    issue-closure-1783704294742-88df43bb waiting-quota (fix-all-issues)
Finish, archive, or discard these runs with the 0.x CLI (bunx smthrs@0.35.0 ps), then run this command again.
See https://smithers.sh/migration/1.0#run-data
```

No report directory was written. The only path in the copy newer than the marker is `smithers.db-shm` (mtime moved by the read-only WAL-mode open); the three database files hash identical before and after.

### 4b. Operator path: the `smithers-migrate` bin in its default `plan` mode

The bin was built in the clean checkout (`corepack pnpm run build` in `packages/migrate`, exit 0, 12:02:00Z to 12:02:33Z; log: `bin-build.log`; output `dist/esm/flow/bin.js`, 4,882 bytes, git-ignored) and run with no mode flag (console `plue-plan.out`, timing `plue-plan.err`):

```sh
node <clean-checkout>/packages/migrate/dist/esm/flow/bin.js --root <S>/phase7/plue-pack-copy
```

| Result | Value |
| --- | --- |
| Exit code | 0 |
| Wall time | 496.37 s (user 133.09 s, sys 50.48 s) with the 1-minute load average between 40 and 63; the prior run took 308.74 s at a load near 10 for the same CPU time |
| Mode (report.json) | `plan`, `exitCode` 0, generated 12:10:05Z |
| Units | 51: 36 planned, 15 blocked, 0 migrated, 0 failed (1 dependencies, 46 workflow, 3 integration, 1 project) |
| Inventory | 1020 construct rows over 46 detected workflow files, 36 mapping decisions |
| Run state | `blocked`: `smithers.db` readable, 21 schema migrations, runs by status cancelled 4 / failed 1 / finished 8 / waiting-quota 1; 0 live, 1 parked (`issue-closure-1783704294742-88df43bb`, `fix-all-issues`, `waiting-quota`); state dir `.smithers/executions` (4 files, 2,163 bytes); no Postgres or PGlite settings |
| Operator instructions | 2: "cancel or accept the loss of these parked runs; the 1.0 runtime cannot resume them" and "archive the database: `mkdir -p .smithers-migrate/archive && mv .smithers/smithers.db* .smithers-migrate/archive/`; 1.0 does not import history" |
| Unresolved / unsupported / follow-ups | 51 / 20 / 88; unsupported constructs `openSmithersBackend`, `MergeQueue`, `Worktree`, `UI`, `ctx.worktreePath`, each named with its file and line (for example `openSmithersBackend at workflows/alpha-plue.tsx:851`, `MergeQueue at workflows/batch-issues/components/BatchLoop.tsx:81`) |
| Blocked units | `workflow:{alpha-plue, workflow, byok-subscription-accounts-monitor, byok-subscription-accounts, create-workflow, docs-concision, docs-driven-development, fix-all-issues, issue-pipeline, ci-fast, ci-thorough, research-plan-implement, ticket-fleet, ticket-kanban}`, `integration:gateway-client` |
| Report | `plue-pack-copy/.smithers-migrate/report.md` (460,416 B) and `report.json` (1,186,171 B); copies preserved at `reports/plue-pack-copy/` |

Every count matches the prior run at `20b32c6316` byte for byte in the report sizes, which is expected: `packages/migrate` did not change between the two commits and the pack copy is the same tree.

This is the rc-contract section 6 shape for `plan`: the parked run is read through the real 0.x SQLite database, the operator instructions are printed, every construct without a counterpart is named with its file and line, and the exit code stays 0 because nothing was refused yet.

Write containment, proven two ways:

- Marker sweep: `touch` a marker before the run, then `find plue-pack-copy -newer marker -not -path '<copy>/.smithers-migrate*'`. Two paths: the copy's root directory (its mtime moved because `.smithers-migrate/` was created inside it) and `smithers.db-shm` (mtime moved by the read-only WAL-mode open). No file content outside the report directory changed.
- Byte comparison: sha256 of `smithers.db`, `smithers.db-wal`, and `smithers.db-shm` is identical before and after both runs, and identical between the copy and the real tree.

The real Plue tree afterwards: no `.smithers-migrate*` exists under `/Users/williamcory/plue/.smithers`, no path under it is newer than the first marker, its database files hash identical to the copy's, and `lsof` on them is empty. `git status -- .smithers` in Plue shows the same five pre-existing uncommitted entries as before the gate (`bun.lock`, `package.json`, `ui/fix-all-issues.tsx`, `workflows/batch-issues/package.json`, `workflows/ci.tsx`); they belong to the Plue lane, not this gate.

## Observations for the orchestrator (none blocks this gate)

1. The two entry points still behave differently in `plan` mode on a project whose `<root>/smithers.db` holds a non-terminal run. `smithers-migrate` (the `npx @smthrs/migrate` path) plans, exits 0, and writes the blocked report with the run list (4b). `smithers migrate` refuses first, exits 1, prints the run list, and writes no report (4a). Both refuse to transform, exit non-zero on `--apply`, and write nothing; the difference is whether an operator with a parked run can get a plan report from the verb. The rc-contract does not pin which of the two an operator should expect from `plan`. Unchanged since the prior run; a one-line ruling and a `packages/cli/test/Bin.test.ts` pin would close it.
2. The `smithers` executable builds its durable layers before any verb runs, and that creates `<project root>/.flows/control.db` and `engine.db`. When the verb takes a path argument the databases land at the caller's project root (this gate's section 3 runs from the checkout root created `<clean-checkout>/.flows/` at 12:02:55Z). When the operator runs `smithers migrate` from inside the 0.x project, which is the spelling the rc-contract section 6 notice and the `smthrs` deprecation text both give, a `plan` run leaves `.flows/` with two SQLite databases inside the 0.x project (section 3, last row), and because section 6 gates the notice on "no `.flows/` beside it", the notice never prints there again. `flows/pack.test.mjs` documents this as intended ("Once `.flows/` exists the project is mid-migration"). The `@smthrs/migrate` README's "plan writes only the report" holds for the tool itself; the CLI wrapper adds its own state directory. Advisory: either exclude `.flows/` from the verb's project when the target is a 0.x root, or document the two files in the migration guide.
3. When the database sits at `.smithers/smithers.db` instead of `<root>/smithers.db` (the `persisted-db` fixture, a non-default 0.x location), the verb's pre-check does not see it and the `@smthrs/migrate` gate is what refuses `--apply` (exit 3). That message names the instruction categories but not the run ids; the plan report names them. Section 3 shows both. Unchanged since the prior run.
4. Scoping note on the copy: the copy root is the pack directory itself, so the 996 MB `executions/` at the copy root is not `.smithers/executions` relative to that root. The scanner recorded the nested `.smithers/executions` as the state directory and the root `smithers.db` as the database, and the `PlueGolden` test asserts the walk never enters `executions/` or `.worktrees/`. An operator run at the Plue project root would see `.smithers/executions` and the 771 MB `/Users/williamcory/plue/smithers.db`.
5. Shared-checkout concurrency: another lane ran a workspace build in the same checkout during this gate. It wrote `packages/cli/dist` at 12:08:34Z (after every CLI-verb invocation of this gate had ended, so all of them ran `src/bin.ts`) and rebuilt `packages/migrate/dist` at 12:10:38Z (its `build.mjs` removes `dist/` first) while this gate's `smithers-migrate` process, started at 12:05:08Z from the 12:02:33Z build of the same commit, was still running. Node had already loaded the modules, and the run completed with exit 0 and a complete report (the JSON parses and its counts match the prior run). `<clean-checkout>/.flows/cache/` (12:13:37Z) also belongs to another lane; `.flows/control.db` and `engine.db` there belong to this gate (observation 2). The tracked tree stayed clean throughout.

## Footprint of this gate

Inside the clean checkout, all git-ignored: `packages/migrate/dist/` (this gate's build, since rebuilt by the concurrent lane), `packages/migrate/node_modules/.migrate-bin/bin.mjs` (the `Bin` suite's bundle), and `.flows/control.db` plus `.flows/engine.db` at the root (observation 2). Outside it: `<S>/phase7/plue-pack-copy` (kept; an APFS clone that shares blocks with the original), `<S>/phase7/migration-tool-logs/`, and the two marker files `plue-cli-marker` and `plue-copy-marker`. Scratch fixture copies were removed.

## Verdict

PASS. From the clean checkout at `cd14388ed7`, the `@smthrs/migrate` suite is green (374 passed, 0 failed, coverage above every threshold; the only skips are the credential-gated live-model file, the absent 0.x checkout drift check, and two correct-branch placeholders), the migration flow's own 0.x fixture passes the real detector and the real CLI (73/73), the `smithers migrate` verb plans a clean fixture, changes nothing in scan mode, and refuses `--apply` with exit 3 on a fixture with a live run, and the operator-path dry run over a full byte-clone of the real Plue pack exits 0, reads the persisted 0.x run state through the real SQLite database, reports the blocked verdict with the section 6 operator instructions, and writes nothing outside `.smithers-migrate/`. Apply was never run against the real Plue tree or any real project.
