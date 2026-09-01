# @smthrs/control

## [Unreleased]

## [1.0.0-rc.0] - 2026-09-01

### Added

- Added `ControlExecutor`, the port that hands launches, cancellations,
  signals, and resumes to a real run executor, so `ControlLive` drives an
  engine instead of describing one.
- Added `SqlControlRuntime`, the durable `ControlRuntime` over `@smthrs/journal`
  and the fenced `@smthrs/run-store`, and the credential subsystem behind it
  (`Credential`, `CredentialCipher`, `CredentialStore`, `SqlCredentialStore`,
  `WebCryptoCipher`).
- Added durable resume delegation: a decided run's restart is recorded for the
  host that owns it and taken up on that host's next poll, rather than claimed
  by a control plane with no executor (triage B-15).
- Added cancellation attribution: `control.run.cancel-requested` carries the
  authenticated principal and the operator's stated reason, and
  `Cancellation.attribute` folds a run's own evidence and its ancestors' into
  `RunSummary.cancellation`.
- Added `NoMatchingWait`, so a signal naming a wait point no run has open is
  refused where it arrives instead of being recorded as delivered.
- Added `Monitor`, which classifies run health from durable evidence and
  applies only the remedies `autoHeal` names.
- Added `Lineage` and `Steering` projections, so a client reading the journal
  directly reaches the same conclusions the server does.
- Added `ControlSchema.defaultPageSize`, `ControlSchema.maxPageSize`, and
  `ControlSchema.PageLimit`, so a listing has a documented bound the wire
  enforces.
- Added `ControlError.ControlErrorSchema` as the single membership list for the
  `ControlError` union, and added `CredentialConflict` to it.
- Added `SystemFlows.plannable` and a `plannable` marker on every catalog entry,
  so a verb the release contract removed cannot be planned as a flow.

### Changed

- `Control.run({_tag: "Resume"})` is the same operation as `Control.resume`.
  It used to be a second path that claimed without `scope: "launched"` (which
  overwrote an engine-created run's continuation state), replayed a recorded
  receipt for a run that had since settled, and journaled `control.run.resumed`,
  which the agent bridge reads as an approval delegation.
- `Control.resume` records the authenticated principal and the stated reason on
  `control.run.resume`, and the `Resume` RPC payload carries `reason` so a local
  and a remote resume no longer differ.
- `Control.plan` journals `control.plan.created` only when it created a plan.
  `ControlRuntime.plan` returns `{ card, created }` to say which happened.
- `Control.list` reads one run through `getRun` when `filters.runId` names one,
  instead of projecting every row in the database.
- `Control.list` refuses `filters.principalId`. It was accepted and applied
  nowhere, so a caller using it as a tenant restriction received every run.
- `Control.list` refuses a page size that cannot make progress and a cursor it
  did not issue, and applies `defaultPageSize` when the caller names none. A
  zero-sized page used to answer with a cursor a client loops on forever.
- `Control.steer` refuses a message whose `message.runId` disagrees with the
  run the call names, and records the message's stated `createdAt` on
  `control.steer.enqueued`.
- `Control.watch` refuses `afterSequence` without `runId`. Journal sequences are
  partition-local, so one scalar cursor applied to every partition skipped
  unseen entries in all of them but its own.
- A cancel that learns the engine row already settled reconciles the control row
  onto the engine's own status instead of leaving it non-terminal forever.
- Idempotency fingerprints are canonical bytes with the two server-stamped
  principals removed, so key order no longer decides identity and a nested
  `principal` in a payload is caller intent again.
- `Monitor` records `control.monitor.healed` only for an `Accepted` or
  `AlreadyApplied` receipt, stops on a `Terminal` one, and no longer resets its
  stall evidence for a remedy that was refused.
- `SqlControlRuntime.listRuns` omits a row deleted between reading the id index
  and reading the row, instead of collapsing the whole listing to `[]`.
- `SqlControlRuntime.make` is the only exported constructor; the duplicate
  `make_` and the re-exported `FlowId` are gone.

### Removed

- Removed `Control.pause`. The frozen 1.0.0-rc.0 contract has no pause verb; an
  operator park is written through
  `ControlRuntime.writeStatus(runId, fence, "parked")`.
