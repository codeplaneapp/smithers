# Phase 7 gate: migration-tool

Verdict: PASS

PLAN Phase 7 line: "migration workflow tests against representative 0.x projects."

## Environment

| Item | Value |
| --- | --- |
| Checkout | /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout at `9c464343f0` (`v1/rc0-migration`), `git status --porcelain` empty before and after this gate |
| Node | v24.18.0 |
| Bun | 1.4.0 (canary 1.4.0-canary.1+6618e7f7e) |
| pnpm (corepack) | 11.21.0 |
| Date | 2026-08-30 |
| Credentials | `SMITHERS_MIGRATE_SEAT` unset, `ANTHROPIC_API_KEY` unset, `OPENAI_API_KEY` set but unused (the live suite keys off `SMITHERS_MIGRATE_SEAT`) |

## 1. Package test suite

Command, from `<clean-checkout>/packages/migrate`:

```sh
corepack pnpm exec vitest run
```

This is the package's own `test` script (`vitest`) in one-shot mode; the config enables v8 coverage with 70% thresholds on every metric. Full log: `migration-tool-vitest.log` beside this file.

| Result | Value |
| --- | --- |
| Exit code | 0 |
| Test files | 28 passed, 1 skipped (29) |
| Tests | 374 passed, 6 skipped (380) |
| Duration | 46.89 s |
| Coverage | statements 92.5%, branches 81.79%, functions 94.35%, lines 95.54% (thresholds 70/70/70/70) |

The suite covers the representative 0.x fixtures under `packages/migrate/test/fixtures` (`jsx-single`, `jsx-single.migrated`, `mixed-api`, `batch-issues`, `persisted-db`, `plue-pack`) through the scanner units (`Scan`, `Detect`, `Inventory`, `Mapping`, `Units`, `Checks`, `RunState`, `Report`, `Dependencies`, `PromptHints`, `ZodSchemaHints`, `MigratedFixture`) and the flow suites (`MigrateFlow.dryrun`, `MigrateFlow.scripted`, `Transform`, `Verify`, `Archive`, `Checkpoint`, `Finish`, `Contract`, `Gate`, `Command`, `Layers`, `Bin`, flow `Dependencies`). `PlueGolden.test.ts` ran its live branch: it scanned the real `/Users/williamcory/plue/.smithers` read only, resolved every inventory name against the catalog, and asserted the walk never enters `executions/` or `.worktrees/`. All fixture flows that write do so in per-test tmp copies (`copyFixture`); nothing in the suite touches a real project.

The 6 skipped tests, each by the suite's own design:

| Test | Reason |
| --- | --- |
| `MigrateFlow.live.e2e.test.ts` (3 tests, the 1 skipped file) | `SMITHERS_MIGRATE_SEAT` is unset. The tool hard-codes no model, so the suite refuses to pick one and spend money; the skip reason is printed by the test itself. Environmental, operator-owned spend. |
| `Generated.test.ts` "matches what the old checkout generates today" | `/Users/williamcory/smithers/packages/smithers/package.json` does not exist: `~/smithers` is now the v1 tree, so the committed `FacadeExports.ts` catalog cannot be regenerated from a 0.x checkout on this machine. The committed-catalog assertions in the same file ran and passed. Environmental. |
| `PlueGolden.test.ts` absent-machine placeholder | Skipped because Plue IS present; the real branch ran. Correct branch. |
| `Checkpoint.test.ts` no-`jj` placeholder | Skipped because `jj` IS on PATH; the real jj checkpoint test ran. Correct branch. |

CI wiring: `pnpm exec smithers-build query '//packages/...'` lists `//packages/migrate:test` (with `check`, `circular`, `docs`, `fmt`, `lib`, `lint`), so the workspace-graph CI job runs this suite.

## 2. Dry run over a copy of the Plue pack

The real tree at `/Users/williamcory/plue/.smithers` was never a write target. `lsof` on `smithers.db` and `smithers.db-wal` returned nothing (no live 0.x writer), then the whole pack was cloned:

```sh
cp -Rc /Users/williamcory/plue/.smithers <S>/phase7/plue-pack-copy   # APFS clonefile, 86.6 s
```

The copy is complete: 153,754 files and 4.2 GB in both trees, including `smithers.db` (45 MB), `node_modules` (747 MB), `executions/` (996 MB), and `workflows/` (2.4 GB).

The operator-path bin was built (`corepack pnpm run build` in `packages/migrate`, exit 0) and run in its default `plan` mode. `--apply` was never passed anywhere in this gate:

```sh
node dist/esm/flow/bin.js --root <S>/phase7/plue-pack-copy
```

| Result | Value |
| --- | --- |
| Exit code | 0 |
| Wall time | 228.28 s |
| Mode (report.json) | `plan` |
| Units | 51: 36 planned, 15 blocked, 0 migrated, 0 failed |
| Inventory | 1020 construct rows across 46 workflow files |
| Run state | `blocked`: `smithers.db` readable, 21 migrations, 0 live runs, 1 parked run (`issue-closure-1783704294742-88df43bb`) listed by the read-only `node:sqlite` scan |
| Unresolved / unsupported / follow-ups | 51 / 20 / 88 |
| Report | `plue-pack-copy/.smithers-migrate/report.md` (460 KB) and `report.json` (1.19 MB) |

Console output: `migration-tool-plue-plan.out`; timing: `migration-tool-plue-plan.time`.

This matches the rc-contract §6 policy: `plan` reports the blocked run state, prints the operator instructions (cancel or accept the parked run, archive `smithers.db*`), names the unsupported constructs (`openSmithersBackend`, `MergeQueue`, `Worktree`, `UI`, `ctx.worktreePath`, ...), and still exits 0; only `apply` would refuse with exit 3.

Write containment, proven two ways:

- Marker sweep: `touch` a marker before the run, then `find plue-pack-copy -newer marker -not -path '*/.smithers-migrate*'`. Two paths: the copy's root directory (mtime moved because `.smithers-migrate/` was created inside it) and `smithers.db-shm` (mtime moved by the read-only WAL-mode open). No file content outside the report directory changed.
- Byte comparison: `shasum -a 256` of `smithers.db`, `smithers.db-wal`, and `smithers.db-shm` is identical between the original pack and the copy after the run (the wal hash is the empty-file hash).

The real Plue tree afterward: no `.smithers-migrate/` exists under `/Users/williamcory/plue/.smithers`, and its database files hash identical to the copy's, so the gate wrote nothing there.

## Verdict

PASS. The `@smthrs/migrate` suite is green from the clean checkout (374 passed, 0 failed, coverage above every threshold; the only skips are the credential-gated live-model file, the absent 0.x checkout drift check, and two correct-branch placeholders). The operator-path dry run over a full byte-clone of the real Plue pack exits 0, plans 36 units, reads the persisted 0.x run state through the real SQLite database, reports the blocked verdict with the exact §6 operator instructions, and writes nothing outside `.smithers-migrate/`. Apply was never run against the real Plue tree or any real project.
