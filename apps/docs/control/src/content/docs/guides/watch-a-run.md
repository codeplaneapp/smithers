---
title: "Watch a run's events"
description: "Read a finite snapshot or follow a live stream of control events, resume at a cursor without seeing an entry twice, and read the lineage and steer-delivery deltas the plane derives."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/control/docs/guides/watch-a-run.md"
---

`watch` streams `ControlEvent` values projected from committed journal entries.
It is a read: nothing you do with the stream changes a run.

## Take a finite snapshot

`follow: false` asks for what is durable when the request is handled. The
stream ends, which is what makes it assertable in a test or usable in a
one-shot report:

```ts
import { Control } from "@smthrs/control/Control"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

const kinds = Effect.gen(function*() {
  const control = yield* Control
  return yield* control.watch({ runId: "run-17", follow: false }).pipe(
    Stream.map((event) => event.kind),
    Stream.runCollect
  )
})
// [ "control.run.accepted", "control.run.running", "flows.engine.attempt-started", ... ]
```

## Follow a live stream

Omit `follow` and the stream stays open. This is what a UI subscribes to:

```ts
const tail = control.watch({ runId: "run-17" }).pipe(
  Stream.runForEach((event) => Effect.log(`${event.sequence} ${event.kind}`))
)
```

A subscriber that arrives late still receives the entries it missed. The
projection pins a high-water sequence per partition, reads everything at or
below it from a finite snapshot, and takes everything above it from the
buffered tail. It is a handoff rather than a deduplicated overlap, so an
arbitrarily long history cannot make an old entry reappear.

## Resume at a cursor

`afterSequence` is a resumable cursor into one run's journal partition:

```ts
const resumed = control.watch({ runId: "run-17", afterSequence: lastSeen })
```

It requires `runId`. Sequences are partition-local, so one scalar applied to
every partition would skip every lower unseen sequence in every partition but
the cursor's own:

```text
InvalidInput: afterSequence: a watch cursor resumes one run, so it requires runId
```

Store `event.sequence` as you consume, and hand the last one back. Derived
events carry the sequence of the entry they came from, so resuming at a cursor
sees each of them exactly once too.

## Watch everything

Omit `runId` and the stream merges every partition the plane knows: each run,
and each plan under `plan:<planId>`. Eight partition snapshots are read at a
time, with one slot reserved so the live tail is never starved behind snapshot
work.

An unscoped watch is the right shape for a dashboard. For a run you can name,
scope it: the scoped watch is one partition read and it is the only form that
can resume.

## Read the derived deltas

Two kinds are computed rather than recorded, and arrive beside the entry they
were derived from:

| Kind                      | Payload                                                     | Means                                        |
| ------------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| `control.run.lineage`     | `{ runId, parentRunId, lineageId?, roundOrdinal?, origin }` | A run was spawned, forked, or handed off to. |
| `control.steer.delivered` | `{ runId, messageId, boundary }`                            | A turn boundary took your steer.             |

Both projections are exported, so a client reading the journal directly reaches
the same conclusions the server does:

```ts
import * as Lineage from "@smthrs/control/Lineage"
import * as Steering from "@smthrs/control/Steering"

const expanded = [...Lineage.expand(event), ...Steering.derive(event)]
```

`expand` returns the entry plus any delta it discloses; `derive` returns the
delta alone. See [Journal projections](/concepts/projections/) for why
delivery is derived rather than written.

## Failures

Every member of `ControlError` can reach a watch stream. In practice you will
meet two:

- `InvalidInput` for an unscoped cursor, as in the preceding section.
- `Unavailable` with feature `watch` when the journal read fails, which is a
  storage failure rather than a missing feature.

A watch of a run that does not exist is not an error. The partition is empty.

## Where to go next

- [Journal projections](/concepts/projections/): partitions, the handoff,
  and the full list of kinds the plane writes.
- [Find runs and page through them](/guides/list-runs/): the point-in-time view.
- [`smthrs logs`](https://smithers.sh/docs/reference/cli/logs/): the operator surface over this verb.
