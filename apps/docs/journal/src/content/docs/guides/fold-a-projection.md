---
title: "Fold a run into a projection"
description: "Write a reproducible reducer over journal entries, run it with project, and bound a live projection so it terminates."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/journal/docs/guides/fold-a-projection.md"
---

A projection is a fold over a run's entries: `{ name, initial, reduce }`. It has
no durable state of its own, so replaying the same entries through the same
reducer must reproduce the same result. That is the whole contract, and it is
what lets a served view be recomputed rather than patched.

## Write the reducer

```ts
import { Projection } from "@smthrs/journal"
import * as Effect from "effect/Effect"

interface StepCounts {
  readonly started: number
  readonly finished: number
}

const counts: Projection.Projection<StepCounts> = Projection.make({
  name: "docs/step-counts",
  initial: { started: 0, finished: 0 },
  reduce: (state, entry) =>
    Effect.succeed(
      entry.eventType === "step.started"
        ? { ...state, started: state.started + 1 }
        : entry.eventType === "step.finished"
        ? { ...state, finished: state.finished + 1 }
        : state
    )
})
```

`reduce` returns an `Effect`, so a projection may read a service. Keep it
deterministic anyway: an entry that is not yours returns the state unchanged,
as the fall-through above does.

## Run it

`project` folds `stream` through the reducer and emits a state per step. It
emits `initial` first, then one state for each entry:

```ts
import { Journal } from "@smthrs/journal"
import * as Stream from "effect/Stream"

const snapshot = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  return yield* journal.project(counts, { runId }).pipe(
    Stream.take(4),
    Stream.runCollect
  )
})
```

For a run with three entries, that collects:

```text
[
  { started: 0, finished: 0 },
  { started: 1, finished: 0 },
  { started: 1, finished: 1 },
  { started: 2, finished: 1 }
]
```

`afterSequence` resumes a fold from a cursor, and then only the entries after
it are folded.

## Bound the stream

`project` inherits `stream`'s behavior: it replays and then follows, so it
never completes on its own. A `Stream.runCollect` or `Stream.runLast` with no
bound hangs.

Bound it one of three ways, by what you actually want:

- A **snapshot**: `Stream.take(n)` where `n` is `1` plus the entry count you
  read from `entries`.
- A **live view**: fork the stream and interrupt the fiber when the view is torn
  down. Interruption is clean.
- A **condition**: `Stream.takeUntil` on the state you were waiting for.

## Handle a failing reducer

A reducer that fails ends the stream with `projection_failed`. The journal is
unaffected: later emissions still succeed, and a fresh `project` call folds the
same history again from the start.

## Where projections are used

[`@smthrs/notifications`](https://notifications.smithers.sh/reference/api/) derives its pending-notification
queue this way, and [`@smthrs/gateway`](https://gateway.smithers.sh/reference/api/) recomputes a selector's
rows from accumulated events rather than patching them, precisely because a
reproducible fold is the only delta that cannot disagree with a fresh
snapshot.

## Next steps

- [Read and follow a run](/guides/read-a-run/) for the reads underneath `project`.
- [Checkpoints and compaction](/concepts/compaction/) for what a projection
  does when its cursor falls below the floor.
