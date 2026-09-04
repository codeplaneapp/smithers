---
title: "Scopes and cursors"
description: "What a sync request covers, what a cursor means, why journal sequences have holes, and the difference between an entry that was delivered and one that was applied."
---

Every sync request answers two questions: which runs does it cover, and where
in each of them does it start. The first is a scope. The second is a cursor
set.

## A scope is one run or the whole workspace

```ts
import type { JournalEvent } from "@smthrs/journal"
import type * as SyncProtocol from "@smthrs/sync/SyncProtocol"

const workspace: SyncProtocol.Scope = { _tag: "Workspace" }
const oneRun: SyncProtocol.Scope = { _tag: "Run", runId: "build-42" as JournalEvent.RunId }
```

A run scope names exactly one run. A workspace scope covers every run the
`RunCatalog` lists and the caller is authorized to read, and it reconciles that
set on every round, so a run created after the subscription opened joins it.

`SyncProtocol.covers(scope, runId)` is the predicate both ends use, so a client
validating a server's page asks the same question the server asked when it
built it.

## A cursor is per run, and exclusive

`RunCursor` is `{ runId, afterSeq }`. A `WorkspaceCursor` is an array of them.
`afterSeq` means "entries after this number". It never means "expect the next
number to be exactly one greater".

That distinction is not a detail. Journal sequences legitimately have holes: an
admission the journal dropped leaves a number nothing was ever written at. A
follower that treats a missing number as corruption stalls on ordinary traffic.
Gap detection therefore compares the server's declared covered interval against
the cursor, not the entry sequences against each other. See
[Replay then follow](./replay-then-follow.md) for where that comparison lives.

## One cursor per run, or the request is refused

A cursor set that names one run twice is ambiguous about where the read starts,
so both `Sync.Read` and `Sync.Subscribe` refuse it with `invalid_request`
rather than picking one. `SyncProtocol.duplicateCursorRunId` is the check, and
the client applies it to the server's echoed cursors as well: a response that
names a run twice is a `protocol_violation`.

The schema cannot express uniqueness, so the rule is stated once and enforced
at every boundary that could break it.

## Delivered and applied are different claims

By default a cursor names what a follower was **delivered**. The client hands
an entry to the consumer and moves the cursor in the same step, so a consumer
whose own write then fails holds a cursor naming an entry it never
materialized. On the next subscription that entry is gone.

`SubscribeOptions.apply` upgrades the claim to **applied**:

```ts
import type { JournalEvent } from "@smthrs/journal"
import type { SyncError } from "@smthrs/sync/SyncError"
import * as Effect from "effect/Effect"

const apply = (entry: JournalEvent.Entry): Effect.Effect<void, SyncError> =>
  Effect.logInfo(`applied ${entry.eventType} at ${entry.seq}`)
```

The callback runs to success before the cursor moves. A failure fails the
subscription with that entry unacknowledged, so the next subscription from
`client.cursors` delivers it again. Redelivery is what a retry is here, so the
callback must be idempotent.

Use it whenever the consumer writes somewhere durable. Leave it off when the
consumer is a view that is rebuilt on reconnect anyway.

## The client's effective cursor is the later of two

A `SyncClient` keeps one acknowledged cursor map shared by every subscription
it serves. The position a subscription actually starts from is the later of the
caller's cursor and the acknowledged one, per run.

Both halves matter. A caller that restored its own progress from durable
storage is never regressed and never re-receives entries it has already
materialized. A caller asking for history this client already acknowledged is
fast-forwarded, because the promise every consumer of a shared client depends
on is that an entry is never read twice.

To rebuild a projection from an earlier position, construct a fresh client. Its
acknowledged map is empty, so the caller's cursor is the only one there is.

## Persisting a cursor

`client.cursors` is an `Effect` returning the acknowledged set, canonicalized:
one entry per run, sorted by run id. Read it after the batch you intend to
survive a restart, never before:

```ts
import * as SyncClient from "@smthrs/sync/SyncClient"
import * as Effect from "effect/Effect"

const checkpoint = Effect.flatMap(SyncClient.Sync, (sync) => sync.cursors)
```

Persist the cursors a read returned only after applying the entries that read
delivered. The cursor is a claim about work already done.

## Related pages

- [Replay then follow](./replay-then-follow.md): how the two phases use these
  cursors, and what bounds a page.
- [Compaction and resync](./compaction.md): what happens when a cursor names
  history the journal has deleted.
- [Follow a run](../guides/follow-a-run.md): the task-shaped version of this
  page.
