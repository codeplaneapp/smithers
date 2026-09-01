# Changelog

## [Unreleased]

## [1.0.0-rc.0] - 2026-09-01

### Release notes

> **Databases.** Smithers 1.0.0-rc.0 stores run state in local SQLite only (`@effect/sql-sqlite-node` over Node.js `node:sqlite`). PostgreSQL and PGlite are not supported: no client layer or migration ladder ships, `SMITHERS_BACKEND=pglite|postgres` and `--backend pglite|postgres` exit with `unsupported_database`, and the 0.x `smithers migrate --to` database move is removed. Projects that ran 0.x on PGlite or PostgreSQL must finish or discard their runs on 0.x; there is no import path.

### Added

- Added persisted plan scheduling and reconciliation, workspace and step
  sandboxes, selection and training, local/remote artifact and cache sync,
  metrics, in-process wakes, bounded retention, run-catalog reads, artifact
  garbage collection, and hot backup/verify/restore/fence operations.
- Added cross-process artifact backup leases and frozen-root verification so a
  backup cannot race artifact sweep or publish an incomplete manifest.

### Changed

- Required an owner-liveness probe when constructing the durable engine.
- `DurableEngineState` now requires Effect's `SqlClient` service plus
  `DurableWriter` (the renamed `Database` service).
- Made durable state, journal records, plan mutations, and multi-row selection
  updates transactional, with strict numeric bounds and host-independent
  UTF-16 ordering.
- Snapshot caller-owned descriptors and bytes before asynchronous work, and
  bind checkpoint operations to the configured repository workspace.

### Fixed

- Prevented torn scheduler/journal settlements, retention partial deletes,
  mutable boundary evidence, forged materialization conflicts, ambiguous
  deviation identities, and failure-Exit corruption after in-memory restart.
- Made artifact GC and disaster recovery fail closed on corrupt durable roots,
  and made the local CAS coordinate writers and sweepers across processes.
- Required explicit whole-tree write verification before admitting a sealed
  result to the cross-run cache.
- Quarantined corrupt boundary evidence off succeeded attempt rows after
  journalling the inconsistency, so a later resume returns the durable outcome
  without re-executing the action
  ([#171](https://github.com/smithersai/flows/issues/171)).
- Included recorded-row provenance in corruption journal identities so an
  identically re-corrupted row records a new incident after healing
  ([#172](https://github.com/smithersai/flows/issues/172)).

## [0.1.0] - 2026-08-05

### Fixed

- Removed composition-time throws and structural boundary sniffing by using
  Deferred service wiring and Schema-backed boundary descriptors.
- Supervised ownership heartbeats through structured interruption races.

### Added

- Added the journal-backed engine composition, claim-gated run
  driver, durable deferred and absolute-clock state, action persistence
  wiring, and deterministic test layers.
- Added SQL-backed deferred completions and clock deadlines with owner-fenced
  scheduling, first-writer completion, and restart recovery.
