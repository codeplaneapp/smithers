---
title: "Producer identity and idempotency"
description: "What makes two emissions the same event, why the comparison runs on canonical redacted bytes, what the two dedupe modes mean, and why the in-process index is a cache rather than the authority."
sidebar:
  order: 3
---

A producer that retries must not double an entry. The journal answers that with
one identity and one comparison, both of which are persisted facts rather than
in-memory bookkeeping.

## The identity

`(runId, sourceId, sourceSeq)` is the producer identity. It is unique in the
database, and `JournalEvent.makeEventId` derives the durable `eventId` from it
deterministically, with length prefixes so an identifier containing the
separator cannot forge another tuple's id.

Deterministic is the point: retrying the same source event must produce the
same durable id, so the unique index can collapse the retry onto the committed
row instead of storing it twice.

## What makes two emissions the same event

Two emissions under one identity are the same event when their `eventType` and
their canonically encoded, redacted `payload` and `meta` match.

Canonical encoding is `JSON.stringify` semantics with object keys sorted, so
key order does not change the answer. A `Date` is its ISO string, an
`undefined` member is dropped, and `NaN` is `null`. The sort runs over the
encoded JSON rather than over the raw value, so canonicalization cannot destroy
anything the encoder would have kept.

Two consequences follow from comparing the persisted, redacted bytes, and both
are deliberate:

- Two different secrets that redact to the same placeholder are the same event
  to the journal. Comparing the pre-redaction value instead would keep
  unredacted secrets resident in the in-process index, which is the leak this
  package exists to prevent.
- `NaN` and `null` are the same value, because JSON says so.

## The two dedupe modes

`Input.dedupe` states what a re-emitted identity means. It defaults to
`content`.

`content` is the strict reading: the identity names one set of bytes, so a
producer that re-emits it with different bytes has a bug, and the journal says
so with `idempotency_conflict`.

`identity` is for a producer that derives the sequence from the event itself.
There a collision is the same event observed twice, and the bytes that differ
between the two observations are metadata about the observation rather than the
event: whether a replayed frame was re-recorded, how long a step took the
second time a durable engine served it from its record. The first admitted row
stands and the re-emission settles as `Duplicate`.

Declare `identity` only with a sequence derived from the event's own content.
Otherwise the journal has nothing left with which to notice two different
events wearing one identity.

## The index is a cache, not the authority

`SqlJournalOptions.sourceEventCache` (default 4096) bounds the in-process index
that answers producer idempotency from memory. The database unique constraint
on `(run_id, source_id, source_seq)` stays authoritative, so a miss changes the
receipt, not the durable answer.

On a miss for an explicit producer sequence, the entry is admitted
optimistically without a SQL deduplication lookup:

- `emitLossy` returns `Accepted` where a resident entry would have returned
  `Duplicate`.
- The insert collapses onto the committed row through the unique index rather
  than doubling it.
- A changed retry behind an evicted entry surfaces its `idempotency_conflict`
  from `flush` instead of from the emit.

The deduplication lookup is deliberately deferred to the writer. Allocation
can still read before admission: a cold run needs `MAX(seq) + 1`, and an
omitted `sourceSeq` with an uncached producer floor also needs
`MAX(source_seq) + 1` for `(runId, sourceId)`. Only warmed allocation floors
make admission read-free; an explicit producer sequence avoids only the
producer-floor read.

These reads use the caller's SQL transaction context when the client is shared.
A caller holding the connection in another transaction without propagating
that context can deadlock on a cold admission. See
[the two channels](./two-channels.md) for supported transaction compositions
and the separate commit of queued lossy entries.

Bounding the index also bounds startup. Only the most recent
`sourceEventCache` events are decoded when the layer is built, so resident
memory and startup cost are proportional to the bound rather than to the total
history ever written.

## Identifiers are the persisted key

`RunId`, `SourceId`, and both an `Input`'s and an `Entry`'s `eventType` are
non-empty, at most 1,024 UTF-16 code units, free of unpaired UTF-16 surrogates,
and free of NUL. Each rule closes a way for the identifier the caller decoded
and the identifier the database stores to stop being the same value:

- SQLite binds a lone surrogate as U+FFFD, so two ill-formed identifiers that
  differ only in their surrogates land on one persisted key. The second run's
  first event would dedupe into the first run's row, and a read by either id
  would return the same history.
- SQLite's `length()` stops at the first NUL, so a NUL-bearing identifier fails
  the column's own non-empty check and the caller is told the sink failed about
  an identifier it had just supplied.
- The length bound exists because every identifier occupies permanent index
  space and layer-lifetime heap.

Valid astral text is ordinary text and round-trips exactly. `entries`,
`stream`, `checkpoint`, `latestCheckpoint`, and `compact` decode the same
schemas, so an identifier the writer refuses is refused on every read with
`invalid_event` rather than answered with an empty page.

## Reading a receipt

`Duplicate` carries a `status`, which is the one piece of information the tag
alone does not give you:

- `pending` means the original event is in the lossy queue and not yet
  committed.
- `committed` means the original is already durable.
