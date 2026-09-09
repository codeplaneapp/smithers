---
title: "Subscriptions and cursors"
description: "The frame vocabulary a subscription speaks, why a delta is a full replacement, what a cursor is made of, and which subscriptions can resume from one."
sidebar:
  order: 2
---

`Projection.Snapshot` answers the rows a selector currently projects.
`Projection.Subscribe` answers a stream of tagged frames instead, so a client
can tell a snapshot from a change without guessing.

## The frames

| Frame                | Means                                |
| -------------------- | ------------------------------------ |
| `SnapshotStartFrame` | the snapshot begins, at this cursor  |
| `RowFrame`           | one row of the snapshot              |
| `SnapshotEndFrame`   | the snapshot is complete             |
| `DeltaFrame`         | the selector's rows after one change |
| `HeartbeatFrame`     | the connection is alive              |

`GatewaySchema.GatewayFrame` is the union of all five. Every frame except the
heartbeat carries the selector it belongs to and the cursor it was produced at,
so a client multiplexing several subscriptions on one socket routes on the
frame rather than on the request id.

## A delta is a full replacement

`DeltaFrame.delta` is the whole row set of the selector, recomputed from the
events accumulated so far. It is not a patch.

That is a deliberate trade. A projection is a reproducible fold, and
recomputation is the only delta that cannot disagree with a fresh snapshot. A
patch would have to encode an inverse for every fold, and any bug in one would
leave a client's view permanently wrong in a way nothing detects.

`run-events` is the one exception, and it is not really one: its rows _are_ the
ordered events, so the rows after one change are the rows before it plus the
event that arrived. Its delta carries that one event.

Recomputing is cheap because nothing re-reads the journal. The events are
accumulated in the stream, so following a run never re-reads the journal after the snapshot
cutoff is reconciled. Only `run-summary` and `run-tree` re-read anything, and
only the run row, because their status comes from the row rather than from the
journal.

## A reconciled snapshot cutoff

The gateway reads each run summary before and after its journal snapshot. If
the summary changed, it retries with the new summary, up to eight journal
reads. A row that keeps changing is refused with `run_unavailable`. This keeps
a terminal event from being acknowledged with the preceding run status.

Snapshot rows and the follow seed share the same final event buffer. Workspace
snapshots reconcile up to eight runs concurrently. Listing stops at 500 runs,
an empty page, or a repeated cursor; each continued page adds a run, so at most
500 pages are read.

An empty event buffer follows from the beginning, including journal sequence
zero. A buffer that already contains sequence zero suppresses those seeded
events, including their derived offsets.

## What a cursor is

`GatewaySchema.ProjectionCursor` carries five things:

| Field        | Holds                                                                         |
| ------------ | ----------------------------------------------------------------------------- |
| `selector`   | the exact selector that issued it                                             |
| `projection` | that selector's projection name                                               |
| `runId`      | the source run, or `null` for a workspace projection                          |
| `value`      | the journal sequence the read reached                                         |
| `offset`     | the position within that sequence, for several derived events at one sequence |

The selector is embedded rather than referenced, so two `node-output`
subscriptions on different nodes of one run cannot share a cursor. The
`(value, offset)` pair rather than a bare sequence is what lets a client resume
inside one journal sequence without losing a derived event.

## Resuming

Pass a cursor as `after` and the subscription skips the snapshot, answering the
deltas after that cursor alone. The read still happens, because a folded
projection cannot be recomputed from the events after the cursor alone. What
the client skips is receiving rows it already has.

A cursor is refused with `malformed_request` when it:

- names a different projection than the subscription's selector;
- names a different selector of the same projection;
- names a different run than the subscription's;
- is negative, fractional, or not a safe integer in `value` or `offset`;
- names a position past the run's last position;
- names a position the run never issued.

## Workspace subscriptions do not resume

Control journal sequences belong to per-run partitions, so there is no
workspace-wide sequence to advertise. A workspace cursor is therefore always
`value` 0 with a `null` run, and passing one back is refused: a
`workspace-runs` or unscoped `approvals` subscription has no resumable cursor
at all.

It can still follow, and does, by following every partition without a cursor.
The follower drops replay through each retained run's last sequence and
duplicate-sequence offset. Each source stores that position and updates it on
append, so checking replay does not scan its journal.

Sources and cached exclusion verdicts share a `maxWorkspaceRuns` ceiling of
500 entries. An excluded run retains its journal cutoff and observed position,
without its history. Replayed events through that cutoff cost no further
journal reads; later events reconsider the run. Missing run partitions,
including `plan:` partitions, are skipped after the first lookup failure while
the verdict is retained. New entries evict the oldest exclusion verdict and
its cursor state. An evicted run may require another read. At 500 admitted
sources, unseen runs are skipped.

## Heartbeats

An idle subscription emits a `HeartbeatFrame` every
`Projections.heartbeatIntervalMillis`, which is 30 seconds. A relay cuts an
idle tunnel at 600 seconds, so a quiet run has to produce a frame well inside
that window or every follower is disconnected and reconnects. Thirty seconds
leaves twenty heartbeats of margin. `Projections.layerWith` and
`ServerOptions.heartbeatMillis` shorten it for a relay that cuts sooner.

The first tick is dropped, so the cadence is what it says it is: an immediate
keepalive would arrive before the snapshot it is meant to keep alive.

## The other keepalive

`ControlRpcs.Watch` on `/rpc/ws` has the same idle problem and no frame type of
its own for a keepalive, so the gateway publishes one as a `ControlEvent` whose
kind no emitter uses: `GatewayServer.watchHeartbeatKind`, the literal
`control.gateway.heartbeat`. A fold that does not know the kind ignores it,
which is what every fold in this package already does with an unknown kind.

Two properties make it safe to ignore and safe to read:

- It repeats the sequence of the last event delivered, so a client resuming
  from the last sequence it saw does not rewind on a heartbeat.
- It carries the watched run id, so a client routing by run keeps routing.

A snapshot read, `follow: false`, is left alone. It has to end.
