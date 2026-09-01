# @smthrs/run-store

## [Unreleased]

## [1.0.0-rc.0] - 2026-09-01

### Added

- Split out of `@smthrs/journal`: `RunStore`, `AttemptStore`, and `Ownership`
  now live here, and the package owns the `flows_runs` and `flows_attempts`
  migrations. No schema or behavioral change; see
  `docs/pages/concepts/journal.md`.
- `Ownership` re-exports the `OwnerId` schema, which `@smthrs/journal` now
  defines because it is the fence `emitDurable` accepts.
- Package-owned generated API documentation and an explicit Node test subpath.
- Added the `0002_lineage` migration and the `CreateOptions` trampoline pair
  `lineageId` and `roundOrdinal`, read back on `RunRow`. Both absent means the
  run is a lineage of one, read as round 0 of itself.
- Added `RequestCancelOutcome.Terminal`, so a request that lost to an ending
  reports the status it lost to instead of claiming the row is gone.
- Added `ClaimAndOwnOutcome.EvidenceRequired` for a no-evidence claim against
  another live owner, which previously asserted a `SnapshotChanged` comparison
  that branch never performed.
- Added `StealOutcome.LivenessUnconfirmed` for evidence that does not match the
  expected owner, host relation, or observation time before any comparison.
- Added the `RunStoreMetrics` module: the `flows_run_claims`,
  `flows_run_transitions`, and `flows_run_heartbeats` counters plus one
  attributed view per operation outcome, including `abandon_claim` and
  `recover_claim`.
- Added `LivenessCheck`, `LivenessContext`, `leaseLiveness`,
  `sameHostIncarnation`, and `sameHostPidProbe`, so a deployment supplies its
  own liveness answer instead of the store guessing one.
- Added the `Heartbeat` leaf and its `@smthrs/run-store/Heartbeat` subpath, the
  one place `heartbeatInterval`, `heartbeatStaleAfter`,
  `heartbeatSkewAllowance`, and `heartbeatWriteTolerance` are related.
- Added `AttemptStore.Options` (`inProgressStates`, `maxCheckpointBytes`,
  `putMode`) with `makeWith` and `layerWith`.
- Added `AttemptStoreError.method`, so a refusal names the operation that
  produced it and its message reads `<code>: AttemptStore.<method>: <detail>`,
  matching `RunStoreError`.

### Changed

- The injected Effect `Clock` is now the sole authority for ownership and
  lifecycle timestamps. Caller timestamps bind observations but cannot expire
  or extend leases.
- Run and attempt state now crosses a bounded inert-JSON boundary before every
  write and after every read.
- Running snapshots require a complete owner and heartbeat pair; all other
  statuses reject either field, and terminal attempts and runs cannot reopen.
- Same-host PID checks now treat only `ESRCH` as proof of death and fail closed
  on invalid pids or unexpected host failures.
- `RunStore.heartbeat` writes `MAX(heartbeat_at_ms, now)`, so a pulse delayed
  past a newer one cannot move the lease backwards; `AttemptStore.heartbeat`
  does the same.
- `putMode: "upsert"` restates only a row that is still in progress. A finished
  attempt is immutable, and a re-put of one resolves `ExistingSame` or
  `Conflict` rather than reopening it.
- `put` compares an existing row structurally, so a re-put whose JSON carries
  the same content in a different key order resolves `ExistingSame` instead of
  `Conflict`.
- `transitionOwned` refuses `pending` as a target and validates its
  `TransitionGuard` at runtime, so a malformed guard fails instead of silently
  disabling the cancellation rule.
- `RunStoreErrorCode` no longer publishes `unknown`, a code no path in
  `RunStore` produced.
- `./migrations/*` is closed in the export map: the migration modules are
  implementation, reachable only through `Migrations.set`.

### Fixed

- Fenced mutations now validate exact identifiers, monotonic timestamps, and
  complete ownership tuples without retaining executable values in errors.
  A failure cause carries the shape of `state_json`, never its text.
- Cancellation, claim recovery, and attempt update races now resolve to typed
  contention or persistence outcomes instead of ambiguous missing rows.
- Identifiers carrying an unpaired UTF-16 surrogate are refused. SQLite maps
  them to `U+FFFD`, so two distinct run ids collided on one durable key.
- `requestCancel` maps an undecodable persisted status to a typed
  `decode_failed` failure instead of dying.
