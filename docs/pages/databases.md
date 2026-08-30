---
description: "SQLite is the only supported database in 1.0.0-rc.0: the files it writes, the migration ladder, the operating limits, and how PostgreSQL and PGlite fail."
---

# Databases

Smithers 1.0.0-rc.0 stores run state in local SQLite only, through
`@effect/sql-sqlite-node` over Node's `node:sqlite`. This page covers what the
engine writes, what it can promise about it, and what happens when you point it
somewhere else.

## Files

| Path | Holds |
| --- | --- |
| `<project>/.flows/control.db` | the control plane: journal, run store, and the `control_*` and `memory_*` tables |
| `<project>/.flows/engine.db` | the engine ladder: journal, run store, step cache, engine store, plan, and the run-parent edges |
| `<project>/.flows/objects/` | artifact blobs, addressed by digest |
| `<project>/.flows/logs/<runId>.log` | the log of a detached `smithers up -d` |

The database directory is derived from the database file, so a per-task
database path moves the artifacts with it. `NodeRuntime.layer({ filename })`
takes that path.

## Connection settings

The driver opens each file with write-ahead logging on and a five-second busy
timeout, and retries `SQLITE_BUSY` on open through a bounded ladder. Write
transactions go through one durable writer, so a lifecycle journal entry and
the state transition it describes commit together or not at all.

## Migrations

Each file carries one `flows_migrations` table. A package contributes a
`MigrationSet` with a namespace and an id offset, so the ladder is
block-allocated: journal at 0, run store at 1000, step cache at 2000, engine
store at 3000, plan at 4000. Time-travel's block 5000 is not installed by the
CLI in this release.

`rejectSkipped` refuses any set at or below the applied high-water mark that
was not applied, which turns a reordered migration into a startup failure
instead of a silent gap. Two processes migrating one file serialize on the
SQLite write lock.

`smithers doctor` prints the database paths and their ladder state.

## Operating limits

[The SQLite operating envelope](/sqlite-operating-envelope) is the detailed
page. The limits that decide an architecture:

- One engine process per project directory is the documented posture. Ownership
  arbitration makes a second process safe, not fast.
- Writes serialize. Throughput is bounded by one writer per database file, and
  a long transaction blocks every other writer on that file.
- Readers do not block writers under WAL, so sync followers and projections
  read while a run writes.
- The journal grows without bound until something compacts it. `smithers gc`
  and explicit checkpoints are the two ways to bound it, and neither runs
  automatically.

## PostgreSQL and PGlite

Neither is supported. No client layer and no migration ladder ship for them.

| Input | Result |
| --- | --- |
| `SMITHERS_BACKEND` set to anything but `sqlite` | exit 1, `unsupported_database` |
| `--backend pglite` or `--backend postgres` | exit 1, `unsupported_database` |
| `--backend sqlite` | accepted, and does nothing |
| `SMITHERS_TEST_PG_URL`, `SMITHERS_POSTGRES_*` | one stderr line, then ignored |

The write-retry classifier already covers the transient PostgreSQL SQLSTATEs,
so a hand-supplied `PgClient` is degraded rather than unprotected, but the
migration ladder is SQLite-flavoured DDL and no browser or PostgreSQL client
layer ships. A project that ran Smithers 0.x on PGlite or PostgreSQL has no data
path forward: finish or discard those runs on 0.x, then migrate the source. See
[migrating from 0.x](/migration/1.0#databases).

## A 0.x database is not a 1.0 database

`NodeDatabase.layer` refuses to open a file that contains at least one table and
no `flows_migrations` table, and fails with `unsupported_database_file`. That
makes pointing a 1.0 runtime at a 0.x `smithers.db` an error instead of a silent
mixing of two schemas in one file. An empty file and a Smithers 1.0 database
open normally.

## Backup and restore

`@smthrs/engine-store` `DisasterRecovery` takes a hot backup with
`VACUUM INTO`, copies the artifact blobs, and writes a manifest.
`scripts/flows-backup.mjs backup|verify|restore` drives it. Restore clears every
owner fence and parks restored `running` rows as `released`, so a restored
database has no phantom owner. See
[disaster recovery](/disaster-recovery).
