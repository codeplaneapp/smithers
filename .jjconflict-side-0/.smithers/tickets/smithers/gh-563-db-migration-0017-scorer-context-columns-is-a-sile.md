# 🐛 db: migration 0017 (scorer context columns) is a silent no-op on Postgres/PGlite — ledger marks it applied without running anything

GitHub: https://github.com/smithersai/smithers/issues/563

**What happens**
Migration `0017_add_scorer_context_columns` (packages/db/src/schema-migrations.js:709-727) provides only the sqlite `isApplied`/`up`. In `runSmithersSchemaMigrationsPostgres` (schema-migrations.js:876-909), `migration.isAppliedPostgres` is undefined so `alreadyApplied` is false, and `migration.upPostgres?.(pgConn)` evaluates to undefined — the runner executes nothing yet records 0017 in the ledger (line 893).

**Why it's wrong / failure scenario**
A fresh Postgres DB gets `ground_truth_json`/`context_json` via the current create-table statements, but a Postgres/PGlite store created before those columns entered the schema (the Postgres runner predates 0017) is permanently marked migrated without ever receiving the ALTER TABLEs — subsequent scorer writes touching those columns fail. Every other column migration in this file supplies `isAppliedPostgres`/`upPostgres` (e.g. via `addColumnIfMissingPostgres`, schema-migrations.js:301).

**Expected**
0017 follows the LEGACY_COLUMN_MIGRATIONS pattern: `isAppliedPostgres` checks the columns, `upPostgres` uses `addColumnIfMissingPostgres`.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
