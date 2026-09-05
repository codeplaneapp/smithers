---
title: "Execution revisions and cancellation acknowledgement"
description: "Database-owned monotonic run revisions, retained deletion evidence, and fenced acknowledgement of cancellation intent."
---

Migration `0003_execution_revisions` adds `flows_run_source`,
`flows_run_changes`, and nullable `cancel_acknowledgement_json` on `flows_runs`.
It is additive: old rows remain intact and receive a baseline revision in
creation-time/run-ID order. That ordering does not claim to reconstruct their
unknown historical mutations. Old acknowledgement values remain null.

The source table holds a random 128-bit database identity and a non-negative
safe-integer revision. Triggers advance it for every inserted, updated or deleted
run row, including claims, activation, heartbeat, wait fields, cancellation,
parent/lineage changes and terminal settlement. Trigger effects roll back with
the mutation. Safe-integer overflow refuses the mutation instead of wrapping.
Run IDs are immutable; deletion followed by creation is a new, higher revision.

`flows_run_changes` holds the latest revision and deletion flag for each run ID.
Multiple mutations coalesce; revisions are not journal event sequence numbers.
Deleted IDs retain their tombstones indefinitely. No ordinary retention pass or
consumer acknowledgement removes them. This policy protects consumers offline
for any duration without assuming a consumer lease. It costs one retained entry
per distinct deleted ID. Recreating an ID replaces the tombstone with a newer
live revision. A future compaction policy must first provide registered-consumer
watermarks and a durable rebuild protocol.

`RunStore.acknowledgeCancel(runId, owner, nowMs)` records the first observing
owner and time. The SQL mutation requires both durable intent and an exact
running owner fence. It returns true for a matching owner, preserving the first
acknowledgement on repetition, or false when intent or ownership is absent.
Invalid inputs and storage failures use the existing `RunStoreError` channel.
`makeNoop` returns false for this operation.

Intent, acknowledgement, and terminal cancellation are distinct facts. A request
can exist before the owner observes it. An acknowledgement can exist while user
cleanup is still running. Neither acknowledgement nor a cancelled lifecycle
proves an arbitrary external effect was undone.

The engine owns the public snapshot and change-feed ports that consume this
tracking state. Its wait payload already lives on the run row, so parking and
waking advance the same revision. Engine-store's additive migration binds
durable spawn-parent changes to the affected child's revision as well.

The identity survives connection and process restarts. Backups copy that identity;
independently writing divergent copies or restoring an older revision requires
explicit source rotation and projection rebuild by the host. Revisions are local
to one database. They do not establish a transaction with the separate control
database, and a projection's applied watermark can lag the engine's watermark.

See [engine observation and listing](https://engine-store.smithers.sh/guides/observe-executions/)
for bounded snapshots, keyset cursor semantics, live-page concurrency and the
revision comparison that rejects stale projection updates.
