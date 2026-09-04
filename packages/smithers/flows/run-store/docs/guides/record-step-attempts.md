---
title: "Record a step attempt"
description: "Start, checkpoint, finish, and annotate one execution of a step: the attempt identity, the run fence every write inherits, first-writer-wins versus upsert, and what patch is for."
sidebar:
  order: 3
---

An attempt is one execution of one content-addressed step inside a run. The
store holds four operations that move it and one that reads it, and every write
is fenced on the run you own.

## The identity

An attempt is addressed by three fields:

```ts
import type { AttemptId } from "@smthrs/run-store/AttemptStore"

const id: AttemptId = { runId: "run-1", stepKeyDigest: "sha256-9f2c", attempt: 0 }
```

`stepKeyDigest` is the step's content address, so the same step in two runs
shares no row, and a retry of the same step increments `attempt` rather than
overwriting the previous try. All three are the table's primary key.

## Start it

`put` inserts the row, and the insert only lands while the run is `running` and
owned by the caller:

```ts
import { AttemptStore } from "@smthrs/run-store"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"

const start = (id: AttemptId, owner: OwnerId) =>
  Effect.gen(function*() {
    const attempts = yield* AttemptStore.AttemptStore
    return yield* attempts.put({
      ...id,
      state: "running",
      startedAtMs: yield* Clock.currentTimeMillis,
      meta: { step: "fetch", cached: false }
    }, owner)
  })
```

`meta` is required and opaque: its shape belongs to the step executor, and the
store carries it unchanged across every later state change. `state` is a name
you choose, and the store only cares whether it is in `inProgressStates`.

Five outcomes are possible, and only one is a defect:

| Outcome        | Meaning                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Inserted`     | The row is new.                                                                                                         |
| `Upserted`     | `putMode: "upsert"` replaced a row that was still in progress.                                                          |
| `ExistingSame` | A row already exists and is byte-equivalent, so the write was a no-op. Object key order is ignored; array order is not. |
| `Conflict`     | A row exists with different content, and the store is first-writer-wins.                                                |
| `RunNotFound`  | The run row does not exist.                                                                                             |
| `FenceLost`    | The run exists but is not `running` under your owner.                                                                   |

`ExistingSame` is what makes a replayed `put` safe. `Conflict` means two
writers disagree about what this attempt is, which is a bug in the caller.

## Checkpoint it

`heartbeat` proves the attempt is still moving and optionally saves the value it
would resume from:

```ts
const beat = (id: AttemptId, owner: OwnerId, checkpoint: unknown) =>
  Effect.gen(function*() {
    const attempts = yield* AttemptStore.AttemptStore
    return yield* attempts.heartbeat(
      id.runId,
      id.stepKeyDigest,
      id.attempt,
      owner,
      yield* Clock.currentTimeMillis,
      checkpoint as AttemptStore.JsonValue
    )
  })
```

The checkpoint argument is optional, and omitting it leaves the stored one
alone: the column is written with `COALESCE`, never cleared. The heartbeat
stamp is monotonic, so a delayed pulse cannot move it backwards.

`heartbeat` fences on two things: the run must be `running` under your owner,
and the attempt's `state` must still be one of the store's `inProgressStates`.
Those two are reported separately. `FenceLost` means the run moved on;
`StateChanged` means you still own the run but the attempt is no longer in
progress, so something already finished it.

## Finish it

`finish` moves the attempt to a terminal state and records how it ended:

```ts
const succeed = (id: AttemptId, owner: OwnerId, outcome: AttemptStore.JsonValue) =>
  Effect.gen(function*() {
    const attempts = yield* AttemptStore.AttemptStore
    return yield* attempts.finish({
      ...id,
      state: "completed",
      finishedAtMs: yield* Clock.currentTimeMillis,
      outcome
    }, owner)
  })
```

The target `state` must not be one of `inProgressStates`; passing one fails
with `invalid_attempt`. `error`, `outcome`, and `meta` are all optional, and an
omitted field is left as recorded rather than cleared, so a terminal transition
never erases a value written mid-flight. Supplying one replaces it atomically
with the terminal state, which is how an executor durably records what it
learned while handling a failure.

The outcomes match `heartbeat`: `Finished`, `NotFound`, `FenceLost`, or
`StateChanged`. A second `finish` on an already-terminal attempt reports
`StateChanged`, so repeated terminal transitions never overwrite the winning
row.

## Annotate it without touching its lifecycle

`patch` rewrites the opaque fields and nothing else. It never moves `state`,
`startedAtMs`, or `finishedAtMs`, so it works on running and terminal rows
alike:

```ts
const annotate = (id: AttemptId, owner: OwnerId) =>
  Effect.gen(function*() {
    const attempts = yield* AttemptStore.AttemptStore
    return yield* attempts.patch(id, { meta: { worktree: "/tmp/wt-1" } }, owner)
  })
```

Use it for response text, worktree pointers, cache flags, and quarantined
evidence: the things an executor discovers about an attempt after the fact.
Omitted fields are left as recorded.

`patch` is still fenced on run ownership, and that is the one surprising part.
There is no unfenced write surface, so a delayed patch from an owner that lost
the run reports `FenceLost` instead of rewriting the winning row. After the run
reaches any terminal status its owner columns are cleared, so every patch on it
reports `FenceLost` from then on. Patch before you settle the run.

## Read it back

```ts
const read = (id: AttemptId) =>
  Effect.gen(function*() {
    const attempts = yield* AttemptStore.AttemptStore
    return yield* attempts.get(id)
  })
```

`get` is the one unfenced operation and returns `Option<Attempt>`. Absent
optional columns come back as absent keys rather than nulls, and every stored
value is re-validated on the way out, so a row corrupted outside these stores
fails with `decode_failed` instead of being handed back as state.

## Next steps

- [Durable values](../concepts/durable-values.md): what the admission boundary
  accepts, and the limits on checkpoints.
- [Compose the stores into a host](./compose-the-stores.md): setting
  `inProgressStates`, `putMode`, and the checkpoint ceiling.
