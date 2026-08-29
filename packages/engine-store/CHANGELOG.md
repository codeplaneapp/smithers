# Changelog

## [Unreleased]

### Changed

- Required an owner-liveness probe when constructing the durable engine.
- `DurableEngineState` now requires Effect's `SqlClient` service plus
  `DurableWriter` (the renamed `Database` service).

### Fixed

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
