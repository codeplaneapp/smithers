---
title: "Handle a compacted run"
description: "Fill the history a compaction deleted: write an onResync hook that restores the checkpoint prefix before the client moves the cursor, or fails so nothing is skipped."
sidebar:
  order: 5
---

When a follower's cursor sits below a run's compaction floor, the server
refuses the read with `compacted` and names the checkpoint to resume from.
`SyncClient.subscribe` recovers on its own: it moves that run's cursor to the
checkpoint and restarts, so one compacted run costs a reconnect instead of the
whole subscription.

What the client cannot do is restore the entries the compaction deleted. This
guide is about that hole.

## Decide whether you have a hole at all

You do not, if your consumer holds no derived state. A view that is rebuilt
from whatever the stream delivers next has nothing to lose, and the default
hook is already right for it: it logs the skipped range and continues.

You do, if your consumer folds entries into something durable. The entries
between your old cursor and the checkpoint are gone from the journal and this
wire carries no checkpoint state in their place, so a fold that resumes at the
checkpoint is missing their effect permanently.

## Restore the prefix from the journal

A follower with access to the journal reads the checkpoint out of band. The
hook runs before the cursor moves and must succeed, so restoring here is
ordered correctly with respect to everything that follows:

```ts
import { Journal } from "@smthrs/journal"
import * as SyncClient from "@smthrs/sync/SyncClient"
import { SyncError } from "@smthrs/sync/SyncError"
import type * as SyncProtocol from "@smthrs/sync/SyncProtocol"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

const onResync = (resync: SyncProtocol.Resync): Effect.Effect<void, SyncError, Journal.Journal> =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const checkpoint = yield* journal.latestCheckpoint(resync.runId).pipe(
      Effect.mapError(() =>
        new SyncError({
          code: "compacted",
          message: `Could not read the checkpoint for run ${resync.runId}`
        })
      )
    )
    if (Option.isNone(checkpoint)) {
      return yield* new SyncError({
        code: "compacted",
        message: `Run ${resync.runId} is compacted and has no checkpoint to restore from`
      })
    }
    yield* Effect.logInfo(`restored ${resync.runId} from checkpoint ${checkpoint.value.seq}`)
  })
```

`SubscribeOptions.onResync` is typed `(resync) => Effect<void, SyncError>`, so
resolve the journal before you build the subscription rather than inside the
hook:

```ts
const subscription = Effect.gen(function*() {
  const sync = yield* SyncClient.Sync
  const journal = yield* Journal.Journal
  return sync.subscribe({
    scope: { _tag: "Workspace" },
    cursors: [],
    onResync: (resync) => Effect.provideService(onResync(resync), Journal.Journal, journal)
  })
})
```

## Refuse instead, when you cannot restore

A consumer that must not silently skip history fails the hook. The cursor stays
where it was and the subscription fails, which is a visible outage rather than
a quiet divergence:

```ts
const refuse = (resync: SyncProtocol.Resync): Effect.Effect<void, SyncError> =>
  Effect.fail(
    new SyncError({
      code: "compacted",
      message: `Run ${resync.runId} compacted past this consumer's cursor`,
      resync
    })
  )
```

Failing is the safer default for any projection you cannot rebuild from
scratch.

## Discard the run's derived state

The third answer is to throw away what you have for that run and start again
from the checkpoint. Do it in the hook, so the discard and the cursor move
happen in the right order:

```ts
const discard = (
  forget: (runId: SyncProtocol.Resync["runId"]) => Effect.Effect<void>
) =>
(resync: SyncProtocol.Resync): Effect.Effect<void, SyncError> => forget(resync.runId)
```

## What not to do

Do not widen the cursor yourself in response to a `compacted` error you catch
outside the client. The client already owns that move, and doing it twice skips
entries the second move steps over.

Do not treat `compacted` as retryable. A checkpoint at or below what the
subscription already covers cannot move the cursor forward, so the client
deliberately leaves that case a failure rather than looping on the same
refusal.

## Related pages

- [Compaction and resync](../concepts/compaction.md): what the refusal means
  and why it is recoverable.
- [Checkpoints and compaction](/pkg/journal/concepts/compaction): how a floor
  advances in the first place.
