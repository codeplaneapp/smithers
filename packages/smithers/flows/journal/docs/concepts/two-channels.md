---
title: "The two channels"
description: "Why the journal has a lossless lifecycle channel and a lossy telemetry channel, what each receipt means, and why sequence gaps are valid."
sidebar:
  order: 1
---

The journal has one table and two ways into it. The split is deliberate: a
lifecycle fact and a telemetry sample have different costs when they are lost,
so they get different guarantees and the caller picks.

## The durable channel

`emitDurable(input, owner)` and `emitDurableUnfenced(input)` open a write
transaction inline, allocate the sequence inside it, insert the row, and return
only after the transaction commits. The returned `seq` is therefore already on
disk.

The receipt type says the rest. `DurableReceipt` is `Accepted | Duplicate`, so
a dropped lifecycle event is unrepresentable: the write commits, collapses onto
an identical earlier write, or fails with a typed `JournalError`.

Use this channel for anything a run's correctness depends on. A durable
boundary must not advance a run or expose its result until the lifecycle entry
that describes the move has committed.

## The lossy channel

`emitLossy(input)` validates the event, allocates its sequences from an
in-memory clock, and hands it to a bounded queue that one scoped writer drains
in batches. The call returns before SQL commits. Its `seq` is provisional until
commit; `sourceSeq` remains the stable producer identity.

`EmitReceipt` is `Accepted | Duplicate | Dropped`, and which of those you can
see depends on the layer's `overflow` policy:

| `overflow`    | A full queue produces                                                |
| ------------- | -------------------------------------------------------------------- |
| `reject`      | a `queue_overflow` failure                                           |
| `drop-newest` | a `Dropped` receipt for the event just offered                       |
| `drop-oldest` | an `Accepted` receipt whose `evicted` field counts what it displaced |

Use this channel for telemetry: spans, progress, per-frame samples. A process
crash can lose an accepted but unwritten entry, and that is the trade the
channel exists to make.

`emitLossy` also holds one property the durable channel cannot: it issues no
read and opens no transaction, so it is safe to call from inside somebody
else's open write transaction. A pre-admission dedupe read there would wait on
the writer that is waiting on the caller, which is a measured deadlock and not
a hypothetical one.

## flush is the lossy barrier only

`flush` waits for everything currently queued to reach disk. It says nothing
about the durable channel, which was already committed when its receipt
arrived.

A batch the writer cannot persist is lost and reported once: to the `flush`
waiters that covered it, to live `stream` consumers that were following at the
time, and, if nobody was waiting, to the next `flush`. The writer fiber
survives the failure. Entries queued behind the lost batch stay outstanding, so
a later `flush` still waits for them rather than vouching for unpersisted work.

Never call `flush` inside `transact`. It waits on the queued writer while your
transaction holds the write lock the writer needs.

## Two sequence domains

Every admitted event gets two numbers, and they answer different questions.

- `seq` is the run's canonical durable order. Replay, paging, streams, and
  projections all use it, and it is shared by both channels: a durable entry
  and a lossy entry from the same run interleave in one history.
- `sourceSeq` is per `(runId, sourceId)`. It identifies a producer's retries
  and is the idempotency key. A producer may supply its own; otherwise the
  journal allocates the next one.

## Commit ordering

Both channels allocate canonical `seq` inside the write transaction, above the
run's committed tail. The lossy writer uses its admission reservation as a
minimum. If a durable commit or another journal instance overtakes that
reservation, the queued entry moves forward when it commits. For example,
lossy admission `0`, followed by durable commit `1`, commits the lossy entry at
`2`. Replay and followers then deliver `1, 2`.

The durable tail is therefore a committed-prefix watermark: a pending entry
cannot later commit below it. Readers can advance to the last returned row
without skipping later commits, including commits from independent connections.
No persisted reservation or local pending-writer registry is needed.

Use committed entries or committed duplicate receipts for paging and checkpoint
cursors. An `Accepted` lossy receipt or a pending `Duplicate` carries the
provisional reservation, not a durable cursor. `sourceSeq` and event identity do
not change when the canonical sequence moves. The compaction guard still drops
queued reservations at or below an already compacted boundary and reports the
loss through `flush`.

## Gaps are valid

A rejected or dropped admission still consumes both allocations. Allocation is
`MAX(seq) + 1` and replay is `ORDER BY seq`, so nothing reads a gap as
anything: a missing number is not a missing entry, and no reader should treat
it as one.

The one receipt that consumes neither allocation is a `Duplicate` the
in-process producer index still holds. It returns the original event's
`seq`, provisional while pending and canonical after commit.

## Where the durable channel is fenced

`emitDurable` requires an `OwnerId` and refuses to write behind a live
successor. That is the subject of [the owner fence](./owner-fence.md).
`emitDurableUnfenced` is the same durability with no fence, for an admission
that is genuinely ownerless.
