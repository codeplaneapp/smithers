# Phase 7 gate: migration-tool

Verdict: PASS

PLAN Phase 7 line: "migration workflow tests against representative 0.x projects."

This run supersedes the 2026-08-30 15:59 run at `9c464343f0` (its evidence is preserved under `migration-tool-logs/prior-run-9c464343f0/`). Every log this document cites is under `migration-tool-logs/` beside it.

## Environment

| Item | Value |
| --- | --- |
| Checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-2` at `20b32c6316` (`v1/rc0-migration`), submodule `vendor/jj` at `47589ada7`; `git status --porcelain` empty at the start (06:58Z) and at the end (07:09Z) of this gate |
| Host | macOS Darwin 25.2.0 arm64 |
| Node | v24.18.0 |
| Bun | 1.4.0 |
| pnpm (corepack) | 11.21.0 |
| jj | 0.39.0 (on PATH, so the jj checkpoint test ran) |
| Date | 2026-08-31 (06:58Z to 07:09Z) |
| Credentials | `SMITHERS_MIGRATE_SEAT` unset, `ANTHROPIC_API_KEY` unset, `OPENROUTER_API_KEY` unset, `OPENAI_API_KEY` set but unused: the live suite keys off `SMITHERS_MIGRATE_SEAT` and never picks a model on its own |
| Plue | `/Users/williamcory/plue` at `664c95c609`; `lsof` on `.smithers/smithers.db`, `-wal`, `-shm` returned nothing before the copy and before the run (no live 0.x writer) |
| Concurrent lanes | Other Phase 7 gates ran in the same checkout during this gate (e2e fault suite, `pnpm -r run check`, docs `--check`, npm dry run, examples vitest). Their side effects are called out where they touched this gate. |

## 1. Package test suite (`//packages/migrate:test`)

`corepack pnpm exec smithers-build query '//packages/migrate/...'` lists `//packages/migrate:test` (`Vitest`) beside `check`, `circular`, `docs`, `fmt`, `lib`, and `lint`, so the workspace-graph CI job runs this suite.

Command, from `<clean-checkout>/packages/migrate`:

```sh
corepack pnpm exec vitest run
```

This is the package's own `test` script (`vitest`) in one-shot mode. The config enables v8 coverage with 70% thresholds on every metric and excludes `test/fixtures/**` so the fixtures' own 0.x test files are scanner input, not collected tests. Log: `vitest.log`.

| Result | Value |
| --- | --- |
| Exit code | 0 |
| Test files | 28 passed, 1 skipped (29) |
| Tests | 374 passed, 6 skipped (380) |
| Duration | 54.44 s |
| Coverage | statements 92.5%, branches 81.79%, functions 94.35%, lines 95.54% (thresholds 70/70/70/70) |

A second run with `--reporter=verbose --coverage.enabled=false` (log: `vitest-verbose.log`, exit 0, same 374/6 counts) names every skipped test:

| Skipped test | Reason |
| --- | --- |
| `test/flow/MigrateFlow.live.e2e.test.ts`, 3 tests (the 1 skipped file): "migrates a single-file JSX project through the bin", "records what a single-file project could not settle", "refuses what it cannot translate in a multi-workflow pack" | Printed by the test: "no model credentials: set SMITHERS_MIGRATE_SEAT to a provider:model seat and that provider's key". The tool hard-codes no model, so the suite refuses to spend money on one it picked itself. Operator-owned spend; environmental. |
| `test/Generated.test.ts` > "matches what the old checkout generates today" | `/Users/williamcory/smithers/packages/smithers/package.json` does not exist: `~/smithers` is the v1 tree, so the committed `FacadeExports.ts` catalog cannot be regenerated from a 0.x checkout here. The committed-catalog assertions in the same file ran and passed. Environmental. |
| `test/PlueGolden.test.ts` > "is skipped because the pack is not on this machine" | The placeholder branch. Plue IS present, so the real branch ran: it scanned `/Users/williamcory/plue/.smithers` read only, asserted the walk never enters `executions/` or `.worktrees/`, and resolved every imported name, every inventoried construct, and every component prop against the catalog. Correct branch. |
| `test/flow/Checkpoint.test.ts` > "is skipped because `jj` is not on PATH" | The placeholder branch. `jj` IS on PATH, so the real jj checkpoint test ran. Correct branch. |

Coverage of the representative 0.x fixtures under `packages/migrate/test/fixtures` (each a byte-for-byte copy with a `FIXTURE.md` naming its origin commit): `jsx-single` (`~/smithers` at `cfb570f193`, 0.35.0), `plue-pack`, `batch-issues`, and `mixed-api` (Plue at `2db1ecff21`), `persisted-db` (`jsx-single` plus authored run state, with the database built at test time from verbatim 0.x `CREATE TABLE` statements), and `jsx-single.migrated` (the hand-written 1.0 output the deterministic checks run against). The scanner suites (`Scan`, `Detect`, `Inventory`, `Mapping`, `Units`, `Checks`, `RunState`, `Report`, `Dependencies`, `PromptHints`, `ZodSchemaHints`, `MigratedFixture`, `Generated`) and the flow suites (`MigrateFlow.dryrun`, `MigrateFlow.scripted`, `Transform`, `Verify`, `Archive`, `Checkpoint`, `Finish`, `Contract`, `Gate`, `Command`, `Layers`, `Bin`, flow `Dependencies`) run over per-test temporary copies (`copyFixture`); the `Bin` suite spawns an esbuild bundle of the real `bin.ts` as a process. Nothing in the suite writes to a committed fixture or to a real project.

## 2. The `migrate-smithers-v1` fixture through the real detector and the real CLI (`flows/pack.test.mjs`)

`flows/migrate-smithers-v1/test/fixtures/smithers-0x-hello` is the migration flow's own 0.x fixture. `node --test flows/pack.test.mjs` runs it through `Detect.scan` and through `packages/cli/bin/smithers.mjs` in a detached copy, and asserts `packages/cli/dist` is absent so the spawns run `src/`.

In the shared clean checkout the precondition failed (log: `flows-pack-test.log`, exit 1): `packages/cli/dist/esm/bin.js` existed, written at 00:01 local by the concurrent `pnpm -r run check` lane (`tsc -b`). That build belongs to another gate and was not moved.

The suite was run instead in a scratch shared clone of the clean checkout at the same commit, with a fresh offline frozen install and no `packages/cli/dist` (log: `flows-pack-test-scratch.log`):

```sh
git clone --shared <clean-checkout> <scratch>/cc2-flows && git checkout 20b32c6316487497301db74ec70cbe951428ef53
corepack pnpm install --frozen-lockfile --offline      # Done in 2m 51.9s, exit 0
node --test flows/pack.test.mjs
```

| Result | Value |
| --- | --- |
| Exit code | 0 |
| Tests | 73 pass, 0 fail, 0 skipped (7 suites), 25.3 s |
| 0.x fixture checks | "is detected as a Smithers 0.x project by the migrate detector", "carries the 0.x CLI verbs its package scripts invoke", "holds no 0.x run state, so the migration gate has nothing to refuse" |
| Real CLI checks | "prints the section 6 notice the first time a command runs in it", "passes the migrate verb's 0.x run gate, having no run state to refuse", "is a project the migration planner reads as 0.x work, not an empty directory" |

The scratch clone was removed afterwards. The install printed one warning (`Failed to create bin ... smithers-migrate ... dist/esm/flow/bin.js`) because the scratch clone had no build; the suite does not spawn that bin.

## 3. The `smithers migrate` verb over fixture copies (working-tree CLI)

Fixture copies were placed in the session scratchpad (never the committed fixtures). Commands ran from the clean checkout root through `corepack pnpm exec smithers`, which is `packages/cli/bin/smithers.mjs`; it ran `packages/cli/dist/esm/bin.js`, the concurrent lane's `tsc -b` output of this same commit (the source did not change: `git status` stayed empty). Log: `cli-migrate-fixtures.log`. Every tree was sha256-hashed before and after.

| Command | Exit | Result |
| --- | --- | --- |
| `smithers migrate <jsx-single copy>` (plan) | 0 | "Units: 3 planned, 0 migrated, 0 failed, 0 blocked. Constructs: 11 rows across 7 mapping decisions. Run state: clean." Wrote `.smithers-migrate/report.{md,json}` and nothing else (hash diff outside the report directory: empty). |
| `smithers --quiet migrate --scan <jsx-single copy>` | 0 | Zero bytes changed anywhere, report included. |
| `smithers migrate --apply <persisted-db copy>` with the database built (`run-live` running, `run-parked` waiting-quota, `run-finished`, `run-failed`; 3 schema-migration rows) | 3 | "This project still holds Smithers 0.x run state (blocked). Finish, archive, or discard it, then rerun with --acknowledge-run-state." plus the three operator instructions. Zero bytes changed. `--apply` was passed only here, only against a scratch copy of an authored fixture, and it was refused before the first unit. |
| `smithers migrate <persisted-db copy>` (plan) | 0 | "Run state: blocked." Report lists `.smithers/smithers.db` readable, 3 migrations, live `run-live`, parked `run-parked`. Nothing changed outside `.smithers-migrate/`. Report preserved at `reports/persisted-db/`. |

Harness note: the database build step printed a `UNIQUE constraint failed` stack trace because `make-db.mjs` also runs its own `main` when it is `argv[1]`, so this gate's `node -e` wrapper built the database once (45,056 bytes, four runs, as the plan report confirms) and then called `build` a second time. That is an artifact of the invocation, not of the tool.

## 4. Dry run over a copy of the Plue pack

The real tree at `/Users/williamcory/plue/.smithers` was never a write target and `--apply` was never passed against it or the copy. The pack was cloned whole (APFS clonefile; log: `plue-copy.log`):

```sh
cp -Rc /Users/williamcory/plue/.smithers <S>/phase7/plue-pack-copy   # 111.0 s, exit 0
```

Completeness: 170,482 paths and 4.2 GB in both trees (`find | wc -l`, `du -sh`), including `smithers.db` (46.8 MB), `executions/` (996 MB), `node_modules`, and `workflows/`. `smithers.db`, `smithers.db-wal`, and `smithers.db-shm` hash identical (sha256) between the original and the copy before the run.

### 4a. Operator path: the `smithers-migrate` bin in its default `plan` mode

The bin was built in the clean checkout (`corepack pnpm run build` in `packages/migrate`, exit 0, 18 s; log: `bin-build.log`; output `dist/esm/flow/bin.js`, git-ignored) and run with no mode flag (log: `plue-dryrun.log`, console `plue-plan.out`, timing `plue-plan.err`):

```sh
node <clean-checkout>/packages/migrate/dist/esm/flow/bin.js --root <S>/phase7/plue-pack-copy
```

| Result | Value |
| --- | --- |
| Exit code | 0 |
| Wall time | 308.74 s (user 123.12 s, sys 48.56 s; the machine was shared with the concurrent lanes above) |
| Mode (report.json) | `plan` |
| Units | 51: 36 planned, 15 blocked, 0 migrated, 0 failed (1 dependencies, 46 workflow, 3 integration, 1 project) |
| Inventory | 1020 construct rows across 46 workflow files, 36 mapping decisions |
| Run state | `blocked`: `smithers.db` readable, 21 schema migrations, runs by status cancelled 4 / failed 1 / finished 8 / waiting-quota 1; 0 live, 1 parked (`issue-closure-1783704294742-88df43bb`, `fix-all-issues`, `waiting-quota`); state dir `.smithers/executions` |
| Unresolved / unsupported / follow-ups | 51 / 20 / 88; unsupported constructs `MergeQueue`, `UI`, `Worktree`, `ctx.worktreePath`, `openSmithersBackend` |
| Blocked units | `alpha-plue`, `workflow`, `byok-subscription-accounts-monitor`, `byok-subscription-accounts`, `create-workflow`, `docs-concision`, `docs-driven-development`, `fix-all-issues`, `issue-pipeline`, `ci-fast`, `ci-thorough`, `research-plan-implement`, `ticket-fleet`, `ticket-kanban`, `integration:gateway-client` |
| Report | `plue-pack-copy/.smithers-migrate/report.md` (460,416 B) and `report.json` (1,186,171 B); copies preserved at `reports/plue-pack-copy/` |

This is the rc-contract section 6 shape for `plan`: the parked run is read through the real 0.x SQLite database, the operator instructions are printed (cancel or accept the loss of the parked run; archive `smithers.db*`), every construct without a counterpart is named with its file and line, and the exit code stays 0 because nothing was refused yet.

Write containment, proven two ways:

- Marker sweep: `touch` a marker before the run, then `find plue-pack-copy -newer marker -not -path '*/.smithers-migrate*'`. Two paths: the copy's root directory (its mtime moved because `.smithers-migrate/` was created inside it) and `smithers.db-shm` (mtime moved by the read-only WAL-mode open). No file content outside the report directory changed.
- Byte comparison: sha256 of `smithers.db`, `smithers.db-wal`, and `smithers.db-shm` is identical before and after the run, and identical between the copy and the real tree (`976c4af4...`, `e3b0c442...` the empty-file hash, `fd4c9fda...`).

The real Plue tree afterwards: no `.smithers-migrate*` exists under `/Users/williamcory/plue/.smithers`, no file under it is newer than the marker, and its database files hash identical to the copy's. `git status -- .smithers` in Plue shows five pre-existing uncommitted edits (`bun.lock`, `package.json`, `ui/fix-all-issues.tsx`, `workflows/batch-issues/package.json`, `workflows/ci.tsx`); all predate the marker and belong to the Plue lane, not this gate.

### 4b. The `smithers migrate` verb over the same copy

```sh
corepack pnpm exec smithers migrate --report-dir .smithers-migrate-cli <S>/phase7/plue-pack-copy
```

Exit 1 in 10.0 s (log: `plue-cli-plan.log`, stderr `plue-cli-plan.err`). The verb's section 6 pre-check (`Legacy.refusal` over `Project.legacyDatabases`, the `<root>/smithers.db` walk that matches the 0.x default location) fired before the flow:

```
Refusing to migrate: this project still holds Smithers 0.x run state.
  <copy>/smithers.db:
    issue-closure-1783704294742-88df43bb waiting-quota (fix-all-issues)
Finish, archive, or discard these runs with the 0.x CLI (bunx smthrs@0.35.0 ps), then run this command again.
See https://smithers.sh/migration/1.0#run-data
```

No report directory was written; the only path newer than the second marker is `smithers.db-shm` (read-only WAL open). The real tree stayed untouched.

## Observations for the orchestrator (none blocks this gate)

1. The two entry points behave differently in `plan` mode on a project whose `<root>/smithers.db` holds a non-terminal run. `smithers-migrate` (the `npx @smthrs/migrate` path) plans, exits 0, and writes the blocked report with the run list (4a). `smithers migrate` refuses first, exits 1, prints the run list, and writes no report (4b), which is the section 6 sentence "refuses to transform the project while any exist, and prints the list" applied to plan as well as apply. Both refuse to transform, exit non-zero on `--apply`, and write nothing; the difference is whether an operator with a parked run can get a plan report from the verb. The rc-contract does not pin which of the two an operator should expect from `plan`; a one-line ruling (and a `packages/cli/test/Bin.test.ts` pin) would close it.
2. When the database sits at `.smithers/smithers.db` instead of `<root>/smithers.db` (the `persisted-db` fixture, a non-default 0.x location), the verb's pre-check does not see it and the `@smthrs/migrate` gate is what refuses `--apply` (exit 3). That message names the instruction categories but not the run ids; the plan report names them. Section 3 shows both.
3. Scoping note on the copy: the copy root is the pack directory itself, so the 996 MB `executions/` at the copy root is not `.smithers/executions` relative to that root. The scanner recorded the nested `.smithers/executions` (16 KB) as the state directory and the root `smithers.db` as the database, and the `PlueGolden` test asserts the walk never enters `executions/` or `.worktrees/`. An operator run at the Plue project root would see `.smithers/executions` and the 771 MB `/Users/williamcory/plue/smithers.db`.
4. Shared-checkout concurrency: `packages/cli/dist` from the concurrent `check` lane made `flows/pack.test.mjs` fail its precondition in the shared checkout (section 2; passed in a scratch clone at the same commit). A concurrent lane also modified and then restored `known-files.d.ts` between 07:08:02Z and 07:08:33Z; the checkout was clean at the end.

## Footprint of this gate

Inside the clean checkout: `packages/migrate/dist/` (git-ignored build output) and `packages/migrate/node_modules/.migrate-bin/bin.mjs` (the `Bin` suite's bundle). Outside it: `<S>/phase7/plue-pack-copy` (kept; an APFS clone that shares blocks with the original), `<S>/phase7/migration-tool-logs/`, and the two marker files. Scratch fixture copies and the scratch clone were removed.

## Verdict

PASS. From the clean checkout at `20b32c6316`, the `@smthrs/migrate` suite is green (374 passed, 0 failed, coverage above every threshold; the only skips are the credential-gated live-model file, the absent 0.x checkout drift check, and two correct-branch placeholders), the migration flow's own 0.x fixture passes the real detector and the real CLI (73/73), the `smithers migrate` verb plans a clean fixture, changes nothing in scan mode, and refuses `--apply` with exit 3 on a fixture with a live run, and the operator-path dry run over a full byte-clone of the real Plue pack exits 0, reads the persisted 0.x run state through the real SQLite database, reports the blocked verdict with the section 6 operator instructions, and writes nothing outside `.smithers-migrate/`. Apply was never run against the real Plue tree or any real project.
