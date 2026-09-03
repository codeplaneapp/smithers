# Fixture: `persisted-db`

A Smithers 0.x project that carries run state. It exists to prove the tool refuses to migrate a project with live or parked runs, and that the scanner never writes to a 0.x database.

Origin: the `jsx-single` fixture (`/Users/williamcory/smithers` at `cfb570f193`) plus authored run state.

| Fixture path | Origin |
| --- | --- |
| `simple-workflow.jsx`, `_example-kit.js`, `prompts/**`, `package.json`, `tsconfig.json` | copies of `jsx-single` |
| `.smithers/smithers.config.ts` | authored: `backend: "sqlite"` and a `repoCommands.test` the unit planner reads |
| `.smithers/executions/run-1783757199651/stdout.log` | authored: the execution log directory a 0.x run leaves behind |
| `.smithers/workflows/run-1783757199651.log` | authored after the shape of the real logs at `/Users/williamcory/plue/.smithers/workflows/run-*.log`, trimmed to three lines with the paths replaced |
| `.smithers/claude-mirror-subscriptions.json` | authored after the shape of the real file at `/Users/williamcory/plue/.smithers/claude-mirror-subscriptions.json`, with the run and session ids replaced |
| `old-schema.sql` | verbatim `CREATE TABLE` statements from the old tree, see the file header |
| `make-db.mjs` | builds `.smithers/smithers.db` from `old-schema.sql` |

The database is not committed. `make-db.mjs` builds it into a temporary copy of the fixture at test time, with an injected clock so the live and parked heartbeats are deterministic. Rows:

| Run | Status | Heartbeat | Classification |
| --- | --- | --- | --- |
| `run-finished` | `finished` | 5 days old | terminal |
| `run-failed` | `failed` | 4 days old | terminal |
| `run-parked` | `waiting-quota` | 2 days old | parked |
| `run-live` | `running` | now | live |

Three `_smithers_schema_migrations` rows record migrations `0001_current_tables`, `0014_current_indexes`, and `0025_snapshot_contents`.

Tests derive the Postgres, PGlite, PG-directory, and unreadable-database variants in their own temporary copies.
