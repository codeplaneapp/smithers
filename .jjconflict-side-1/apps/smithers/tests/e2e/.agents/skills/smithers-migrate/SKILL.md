---
name: smithers-migrate
description: Copy the legacy bun:sqlite smithers.db into PGlite or Postgres and write the migrated.json marker. Run `smithers migrate --help` for usage details.
requires_bin: smithers
command: smithers migrate
---

# smithers migrate

Copy the legacy bun:sqlite smithers.db into PGlite or Postgres and write the migrated.json marker.

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--from` | `string` |  | Source backend; inferred when exactly one store has runs |
| `--to` | `string` |  | Target backend; required (pglite, postgres, or sqlite) |
| `--url` | `string` |  | Postgres connection URL when --to postgres |
| `--keepSqlite` | `boolean` | `true` | Keep the legacy SQLite database after a successful copy |
| `--agent` | `boolean` | `false` | Run the durable migrate-repair workflow instead of deterministic migration |
