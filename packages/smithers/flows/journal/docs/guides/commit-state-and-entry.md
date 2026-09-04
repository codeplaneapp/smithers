---
title: "Commit state and its entry together"
description: "Use Journal.transact to append a lifecycle entry in the same write transaction as the state transition it describes, and learn the three rules that keeps."
sidebar:
  order: 2
---

Committing an entry makes that entry durable. It does not by itself make a
host's whole view crash-consistent, because the executable state lives in other
stores: `RunStore`, `AttemptStore`, `CacheStore`, `DurableEngineState`.

`transact` closes that seam. It runs a state transition and the `emitDurable`
calls describing it in one write transaction, so either both land or neither
does.

## Wrap the transition and the entry

```ts
import { Journal, JournalEvent } from "@smthrs/journal"
import * as Effect from "effect/Effect"

const finish = Effect.gen(function*() {
  const journal = yield* Journal.Journal

  return yield* journal.transact(Effect.gen(function*() {
    yield* saveRunStatus(runId, "succeeded")
    return yield* journal.emitDurable({
      runId,
      sourceId,
      sourceSeq: 7 as JournalEvent.SourceSeq,
      eventType: "run.finished",
      payload: { outcome: "succeeded" }
    }, owner)
  }))
})
```

`saveRunStatus` stands for your own store write, whatever it is. The other
stores write through the same `DurableWriter`, so their writes join
this transaction as savepoints. The row and its lifecycle entry commit together
or roll back together. That is what makes the journal an account of
record rather than a best-effort echo.

## Three rules the transaction keeps

**Publication follows commit.** Inside a transaction, `emitDurable` returning
means a savepoint was released, not that anything is visible. The `changes` and
`stream` publish and the in-process producer index update are parked until the
outermost transaction commits. A subscriber therefore never sees an entry that
later rolls back, and a rolled-back producer identity stays re-emittable
instead of deduplicating against a sequence that does not exist.

**Only storage work belongs inside.** The transaction is held for the whole
body. No flow bodies, no host calls, no waits. In particular, never call
`flush` inside `transact`: it waits on the lossy writer, which is waiting on
the transaction you are holding.

**Nesting is a savepoint.** An inner `transact` becomes a savepoint of the
outer one and defers its publication to the outermost commit.

## What a transaction does not buy

A crash before COMMIT loses the whole unit, so work that had already run, an
action body for instance, re-executes on the next drive. Design the body to
tolerate that.

And no local transaction makes a remote effect atomic. External effects still
need idempotency keys, fencing tokens, or compensation.

## A note on retries

The SQLite backends this repository ships give Effect's SQL client no
`beginTransaction` hook, so `DurableWriter.write` opens the default DEFERRED
transaction. Under WAL, a concurrent writer can make the sequence allocation's
lock upgrade fail with `SQLITE_BUSY_SNAPSHOT`, which
[`@smthrs/database`](/api/database) classifies as retryable and replays: the
whole transaction runs again against the committed snapshot, floor read
included.

Allocation is therefore conflict-free by retry rather than by lock escalation.
A `transact` body must be safe to run more than once for that reason as well.

## Next steps

- [The two channels](../concepts/two-channels.md) for why the durable channel
  returns only after commit.
- [Durable execution](/docs/concepts/durable-execution/) for the execution
  model this transaction supports.
