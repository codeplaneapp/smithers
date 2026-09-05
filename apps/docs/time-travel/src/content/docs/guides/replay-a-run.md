---
title: "Replay a run into a view"
description: "Fold a run's committed journal up to a frame through a projection you write: the two read doors, the options that tune the read, and the failures a bad address produces."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/time-travel/docs/guides/replay-a-run.md"
---

Replaying turns a run's history into an answer. You supply a frame and a fold;
the service reads the committed evidence at or below that frame and hands back
whatever your fold built. Nothing is executed, and the run is not touched.

## Write the projection

A projection is two fields: the state before any record, and how one record
folds into it.

```ts
import type * as JournalEvent from "@smthrs/journal/JournalEvent"

interface Progress {
  readonly started: number
  readonly finished: number
}

const progress = {
  initial: { started: 0, finished: 0 } satisfies Progress,
  reduce: (state: Progress, entry: JournalEvent.Entry): Progress =>
    entry.eventType === "flows.engine.attempt-started"
      ? { ...state, started: state.started + 1 }
      : entry.eventType === "flows.engine.attempt-finished"
      ? { ...state, finished: state.finished + 1 }
      : state
}
```

Keep `reduce` pure. It receives store entries by reference, so treat them as
read-only: mutating one rewrites the evidence the fold is still reading.

`reduce` takes a third argument, the sealed result recorded for that entry when
it has one, so a projection can see what a step returned rather than only that
it ran:

```ts
const results = {
  initial: [] as ReadonlyArray<unknown>,
  reduce: (state: ReadonlyArray<unknown>, _entry: JournalEvent.Entry, sealed: unknown | undefined) =>
    sealed === undefined ? state : [...state, sealed]
}
```

## Read at a frame

`inspect` is the short door, under the service defaults:

```ts
import { FlowEngine } from "@smthrs/engine"
import { TimeTravel } from "@smthrs/time-travel"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const timeTravel = yield* TimeTravel
  return yield* timeTravel.inspect(
    { runId: "ledger-1", frame: { lineageId: FlowEngine.Lineage.root("ledger-1"), seq: 17 } },
    progress
  )
})
```

`replay` is the same fold with the read knobs exposed:

```ts
const bounded = Effect.gen(function*() {
  const timeTravel = yield* TimeTravel
  return yield* timeTravel.replay(position, progress, { pageSize: 500, maxHistoryEntries: 5_000 })
})
```

Neither one plans a flow body, dispatches an action, or writes anything.
Replaying the same position a thousand times gives the same answer a thousand
times.

## The two options, and what they do not do

`pageSize` sets how many journal entries are read per page. It defaults to 100
and is a throughput knob only: the fold sees the same entries in the same order
whatever the page boundaries are, so it never changes the derived state. A
value that is not a positive integer is refused `invalid` before the journal is
touched.

`maxHistoryEntries` caps the entries this one call may read at or below the
frame, overriding the service default from
`TimeTravel.layerWith({ maxHistoryEntries })`. A read that would cross it fails
`limit_exceeded` and folds nothing further. The service default is 100,000
entries, published as `defaultMaxHistoryEntries` from
`@smthrs/time-travel/TimeTravel`.

Use the cap when the caller is untrusted or the answer is worth only so much
work. A user-facing inspector that must respond quickly is a better fit for a
low cap than for a long fold.

## Address the right lineage

The fold keeps only entries whose `meta.lineageId` matches the frame, so a run
whose journal interleaves several lineages replays exactly the one you named.
An entry that carries no lineage at all is kept, because dropping it would
silently shorten the fold.

If no entry at or below the frame is on the named lineage, the read fails
`not_found`, naming the lineage and the run. In practice that means one of two
things: the frame's sequence is below the lineage's first record, or the
lineage id was assembled by hand instead of minted by
`FlowEngine.Lineage`. See
[Frames and lineage](/concepts/frames-and-lineage/).

## What a replay cannot tell you

- **Anything uncommitted.** The fold reads durable evidence only. Work in
  flight is not in the answer.
- **Anything that needs re-execution.** There is no dispatcher behind the fold.
  A model call or a child flow can only appear as a cache read, which is the
  property that makes a replay safe to run against a production run.
- **The two recorded facts.** The Jujutsu pointer and the plan digest at a frame
  are recorded as anchors rather than derived; a fold cannot reach them. They
  are what `fork` and `rewind` read.

## Failures

| Code             | Cause                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| `not_found`      | The frame's lineage has no record at or below its sequence in this run.   |
| `invalid`        | A malformed `pageSize` or `maxHistoryEntries`, or corrupt paged evidence. |
| `limit_exceeded` | The fold would read more entries than the cap allows.                     |
| `unknown`        | The journal or the sealed-result cache failed. The cause is attached.     |

## Where to go next

- [Derived state](/concepts/derived-state/): why the fold is the whole
  mechanism, and what bounds it.
- [Fork a run at a frame](/guides/fork-a-run/): acting on the frame you just read.
- [Test against history](/guides/testing/): folding a seeded history in a test.
