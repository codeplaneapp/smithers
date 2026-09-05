---
title: "State and event authority"
description: "Bounded identities, versioned engine history, explicit consumer admission, and the limits of projection recovery."
sidebar:
  order: 7
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/journal/docs/concepts/state-event-authority.md"
---

The journal owns committed history. Engine stores still own executable run,
attempt, deferred and clock state. The additive `EngineEvent` contracts make
history safer to consume; they do not move recovery into the journal.

| Durable concern                           | Authority                        | History relationship                                           |
| ----------------------------------------- | -------------------------------- | -------------------------------------------------------------- |
| Control admission, approvals and signals  | Control records and local events | Separate outbox and receipt contract.                          |
| Execution, attempts, deferreds and clocks | Engine-owned stores              | State and required events share a `DurableWriter` transaction. |
| Ownership leases and fences               | Arbitration store                | Never restored from an old projection.                         |
| Engine history and time-travel evidence   | Typed journal families           | Consumers validate family, version, source and lineage.        |
| Cache and artifacts                       | Validated content and provenance | Cache loss does not erase authoritative completion.            |
| UI and listing summaries                  | Read projections                 | Rebuildability must be demonstrated for each projection.       |

## Shared boundary primitives

`JournalEvent` exports `RunId`, `LineageId`, `WaitId`, `CommandId`, `PlanId`,
`DispatchId` and `ArtifactId`. Each offers a validating `.make(value)`
constructor and a named Effect decoder, such as `decodeRunId(unknown)`.
Identifiers preserve bytes, require 1 through 1,024 UTF-16 code units, and
refuse NUL and unpaired surrogates. Plan, dispatch and artifact brands are
distinct, even when their encoded strings happen to match.

`NonNegativeQuantity` and `TimestampMs` admit safe integers from zero through
`Number.MAX_SAFE_INTEGER`. `PositiveQuantity` starts at one. Fractions,
infinity, string coercion and missing-value defaults are refused. Existing
journal sequences retain their stricter exclusive upper bound.

## Engine families and consumer admission

`@smthrs/journal/EngineEvent` keeps the journal's generic envelope open while
defining two version-2 families:

| Event type                          | Typed payload                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `flows.engine.v2.attempt-lifecycle` | Execution, dispatch, attempt number and running, suspended, succeeded or failed lifecycle. |
| `flows.engine.v2.state-event`       | Execution lifecycle, deferred completion or an absolute clock schedule.                    |

Both payloads require version, run, lineage id, root run, round and parent
where applicable. The committed journal envelope supplies global sequence,
source identity, source sequence and emission time. Root runs have round zero
and no parent; derived runs name a distinct parent and root. A continuation
requires a positive round. Diagnostic `meta` is encoded JSON and grants no
semantic authority.

`decodeEntry(input, consumer)` requires an explicit expected run, lineage,
root, round, parent and source allowlist. It returns a typed `Attempt` or
`State`. Conflicting identity fails `EventError` with code `foreign`.
Malformed supported families fail `malformed`, preserving the original
schema or accessor error in `cause`. Unsupported families and versions in
`flows.engine.*` fail `unsupported`. Other namespaces follow the consumer's
explicit `unknown: "ignore" | "surface"` policy. Source and run admission
still applies to those extensions.

Running and suspended attempts cannot contain completion fields. A terminal
attempt requires its timestamp and a matching encoded success or failure.
Failure reasons distinguish typed error, defect, interruption and encoding
failure. Values must be JSON after the value's own codec has run; a class
instance accepted by `Schema.Unknown` is not an encoded result. Wall clocks
can move backwards, so completion timestamps need not exceed start time.
Suspended executions require at least one typed wait; completed executions
require a result. Ownership and cancellation remain separate facts.

## Additive cutover and retained history

Current engine writers are unchanged. `decodeCurrentAttempt` validates their
actual started/finished markers, using the recorded metadata lineage. It does
not invent a root, round, timestamp or result absent from an old row. That
adapter is explicitly separate from version-2 admission. Generic store
extension points remain generic.

A writer cutover must persist complete lineage and completion evidence,
introduce the new family identity, and write state plus event in the same
transaction. Old histories retain their original bytes and decoder. Backfill
requires authoritative state evidence and an explicit migration; an old
finished marker alone cannot backfill a result. No database column or journal
migration is needed for the additive schemas themselves.

The engine's additive attempt projection demonstrates full-history and
snapshot-plus-suffix equality against real attempt rows at 2 and 70 attempts.
Its tests drop the projection in a subprocess, kill that process, reopen
SQLite with a fresh connection and rebuild it. A version-2 snapshot binds its
rows to lineage and a covering sequence; duplicate identities, foreign runs
and rows past the covering sequence are refused. Compaction requires that
validated snapshot before reading the surviving suffix.

This proof covers the disclosed attempt projection. Journal redaction can
change result content, so it does not prove executable recovery of arbitrary
private values. Retain the authoritative stores, their backup, and operational
fences. A concrete sync consumer still owns atomic snapshot application and
its applied cursor. Extending retention to a public sync projection requires
its own authorization and retention policy.
