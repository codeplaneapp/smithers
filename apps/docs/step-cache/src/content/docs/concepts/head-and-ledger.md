---
title: "The head and the ledger"
description: "Why one put writes two rows: a mutable head an ordinary lookup serves, and an append-only provenance ledger a replay reads, plus the two stages that decide Inserted, ExistingSame, and Conflict."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/step-cache/docs/concepts/head-and-ledger.md"
---

The step cache owns two tables, and the difference between them is the whole
design.

| Table                       | What it is                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `flows_step_cache`          | The mutable head. One row per `key_digest`. This is what an ordinary lookup serves and what an eviction or a sweep reclaims.                                                   |
| `flows_step_cache_recorded` | The append-only ledger. One row per `(key_digest, recorded_run_id, recorded_event_seq)`. This is what a replay of that exact event reads. No verb in this package deletes one. |

One `put` writes both, inside a single `DurableWriter` transaction. A crash
between the two would leave a head a lookup serves without the provenance a
replay reads, and the two answers would disagree forever, so the transaction is
the contract: a process killed mid-`put` leaves neither row, and the file still
takes the next write.

## Why the head may be a cache and the ledger may not

Evicting the head is a judgement about the future: this host observed this
result to be poison, so no later execution should reuse it. Deleting a ledger
row would be a claim about the past, and a past run's projection is a function
of what that run recorded. Rewriting the evidence would change a replayed
answer, so eviction protects future executions without touching recorded
history.

That is why `get(keyDigest, { recordedBy })` reads the ledger first and falls
back to the head only when the ledger holds no row for that provenance. The
fallback exists for entries recorded under some other provenance: a fork
sharing its parent's keys, a shared-tier write-back, a row an earlier build
wrote before the ledger existed.

## The two stages of a recording

`put` decides its answer in two stages, and both matter.

1. **The provenance stage.** The ledger insert runs first, `ON CONFLICT DO
   NOTHING`. If a row already exists under that exact
   `(keyDigest, recordedRunId, recordedEventSeq)`, its complete bytes decide
   the outcome: identical `result`, `meta`, and `createdAtMs` mean this is a
   retry, and anything else is `Conflict`. That record is immutable, so an
   evicted head can be restored from the same bytes and never rewritten with
   different ones.
2. **The head stage.** The head insert runs next, also `ON CONFLICT DO
   NOTHING`. A fresh insert is `Inserted`. An existing row is arbitrated on the
   canonical `result` alone: a second run recording the same result under its
   own provenance carries a different `meta`, `createdAtMs`, and run identity
   without being a conflict, so that is `ExistingSame`.

`Conflict` therefore means one thing only: two runs disagree about what a step
produced. That is the signal an inconsistency receiver acts on, and reporting
it where it has not happened fails a run over a divergence that does not exist.

Whether an insert conflicted, and whether a fenced delete hit, are read through
`affectedRows` from [`@smthrs/database`](https://database.smithers.sh/reference/api/) rather than a
driver-specific `changes` cast, so the outcomes hold on every backend.

## Why canonical form is load bearing

The head stage compares stored text. `JSON.stringify` output depends on key
insertion order, so two structurally equal results built in different orders
compared unequal and produced a `Conflict` that named a divergence that had not
happened. The store canonicalizes `result` and `meta` on the way in, through
[`@smthrs/canonical`](https://canonical.smithers.sh/reference/api/), which makes the text comparison a
structural one. The HTTP tier encodes the same way before it puts an entry on
the wire, so a value with no JSON form is refused identically by both tiers.

## First writer wins, across connections

Two connections putting different results under one digest at the same moment
produce exactly one `Inserted` and one `Conflict`, and the surviving row is one
writer's entry end to end, never a mix of one writer's result with the other's
provenance. Readers racing a writer and a stale fenced eviction see whole
entries or nothing: there is no torn row and no `decode_failed`.

## What reclaims a ledger row

Nothing in this package. Whole-run reclamation belongs to
[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/), whose retention pass erases a
terminal run's ledger rows by `recorded_run_id` together with the journal that
could have replayed them, so the evidence and the frames that would read it go
at the same time.

:::warning
A ledger row whose `recorded_run_id` names no run on this host is never
reclaimed by anything. That is every row `CombinedCacheStore`'s write-back
lands from a shared tier, because the recording run lives on another machine. A
host composing a shared tier accepts `flows_step_cache_recorded` growth
proportional to the remote entries it has read.
:::

## Related

- [Read the result one event recorded](/guides/read-a-recorded-result/):
  the provenance fence as a task.
- [Expire cached results](/guides/expire-cached-results/): the head's
  retention, and why the ledger has none.
- [Content addressing](https://smithers.sh/docs/concepts/content-addressing/): where a
  `keyDigest` comes from.
