---
title: "The journal records"
description: "The two durable events this package owns, why their spelling is frozen, how a queue folds a run's history back into state, and what a projection over a shared journal may assume."
sidebar:
  order: 2
---

The queue keeps no state of its own. Everything it knows comes from two journal
records, and rebuilding from them is what lets a second process answer for a run
the first one admitted to.

## Two event types

| Constant                              | Event type                     | What it records                                               |
| ------------------------------------- | ------------------------------ | ------------------------------------------------------------- |
| `NotificationEvent.AdmittedEventType` | `flows/notifications/Admitted` | One notification and the decision the queue made about it.    |
| `NotificationEvent.PromotedEventType` | `flows/notifications/Promoted` | Which notification ids one boundary of one lineage delivered. |

Both spellings are slashes and a PascalCase leaf, where every other event type
in this repository is dot separated and lowercase. The divergence is deliberate:
the values are already durable in every engine database, and renaming them would
silently stop matching the projections that consumers key on. `test/WireFormat.test.ts`
asserts the literal strings and the literal stored JSON, so a well-meaning
correction fails loudly instead of orphaning history.

An `Admitted` payload is `{ notification, decision }`. A `Promoted` payload is
`{ boundary, targetLineageId, ids }`.

## Replay never re-decides

The decision is recorded because it is a fact, not a derivation. When a queue
folds history, `NotificationState.applyAdmission` applies the committed decision
whatever this process's state would have chosen. A run that filled up under a
capacity of 128 and is now folded by a layer built at 512 replays as what
happened, not as what would happen today.

`rejected-full` is the decision that is never written. The queue refuses a full
queue in the receipt alone, because a rejection recorded as an admission would
match on every later attempt and burn the id forever. The literal stays in
`NotificationEvent.AdmissionDecision` so that a reader is total over a record any
writer could have produced.

## Folding is incremental

A layer folds each run once and then pages only the entries committed since its
last read. It keeps the folded result for the 64 most recently read runs, and a
run evicted from that set is folded again from the beginning on its next call.
Reading a run's history therefore costs what has been journaled since the
previous call, not the run's whole journal.

Eviction is always safe, and so is an interleaved fold: a fold reads the cached
value, pages what has been committed since, and writes a fresh, self-consistent
pair back, so the worst case is one extra page on the next call. No fold can
report a state the journal does not hold.

## Foreign entries are not errors

Journals are shared. `NotificationEvent.fromEntry` answers `Option.none()` for
an entry this package does not own, and for an owned entry whose payload does
not decode, so a projection over a busy journal stays total instead of failing
on somebody else's record.

`NotificationEvent.isAdmitted` and `NotificationEvent.isPromoted` tell the two
owned events apart. They are refinements over the decoded shape rather than a
stored discriminant, because a discriminant would be a durable field this
vocabulary does not have.

## Projections

`Projection.derive` is a `Journal.Projection` that replays the same fold and
emits the state after every entry:

```ts
import { Journal, JournalEvent } from "@smthrs/journal"
import { Projection } from "@smthrs/notifications"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

const watchPending = (runId: string) =>
  Effect.flatMap(
    Journal.Journal,
    (journal) =>
      journal.project(Projection.derive, { runId: JournalEvent.RunId.make(runId) }).pipe(
        Stream.runForEach((state) => Effect.log(`${state.items.length} pending`))
      )
  )
```

`journal.project` replays the run's history and then follows its committed
tail, so the stream does not end on its own. That is what a projection is for:
a live view that stays correct as entries arrive. Bound it with `Stream.take`
when you want a snapshot, or fork it into a scope when you want a follower.

`Projection.derive` starts at `NotificationState.empty(NotificationState.defaultCapacity)`,
which is the bound `NotificationQueue.layer` enforces. A deployment that raised
the bound with `NotificationQueue.layerWith` builds its own projection over
`NotificationState` instead, because this one would report a shorter queue than
the run actually holds.

For the live answer rather than a replay, use `NotificationQueue.pending`; see
[Report what a run is waiting on](../guides/report-pending-notifications.md).
