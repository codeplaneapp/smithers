---
title: "@smthrs/time-travel"
description: "Replay, inspect, fork, and rewind a Smithers run from its journal: one injectable service over durable evidence, with a fenced rewind protocol and crash recovery on layer build."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/time-travel/docs/README.md"
---

`@smthrs/time-travel` reads a run's past out of its journal and lets you act on
it. A run that already happened can be replayed into any view you can write as
a fold, branched into a second run that inherits its history, or truncated back
to an earlier point with its side effects compensated on the way.

All four operations hang off one injectable service:

```ts
import { TimeTravel } from "@smthrs/time-travel"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const timeTravel = yield* TimeTravel
  return yield* timeTravel.inspect(position, projection)
})
```

`replay` and `inspect` fold committed journal entries up to a frame. `fork`
branches a child run off that frame. `rewind` removes everything after it.

## What makes this possible

Nothing here stores "the state at step 17". A frame is an address, not a
snapshot: the pair `(lineageId, seq)` naming a position in the journal that
[`@smthrs/journal`](https://journal.smithers.sh/reference/api/) already keeps. Every answer is derived by
folding the evidence below that address, so the past cannot drift from what was
recorded, and a replay has no dispatcher and can never re-execute a model call
or a child flow.

Two facts a fold cannot derive are recorded as tier-2 anchors: the Jujutsu
pointer that was current when the sequence was journaled, and the plan digest
in force. They are what lets a fork check out the tree the parent had at the
frame, and a rewind put the tree back.

## Who uses this package

Host and control-plane authors provide the store and call the verbs: an
inspector that renders a run at an earlier frame, a branch-and-retry flow, an
operator undo. Adapter authors record effect boundaries with `EffectBoundary`
and contribute the compensations a rewind needs through `CompensationHandlers`.

If you are writing a flow, you reach time travel through the host that wired
it, not from inside the flow body.

## Install

```bash
pnpm add @smthrs/time-travel
```

For the services `TimeTravel.layer` requires and the packages a runnable
composition adds, see [Installation](/installation/).

## The smallest real example

Fold a run's journal at a frame and count the attempts it had admitted:

```ts
import { FlowEngine } from "@smthrs/engine"
import { TimeTravel } from "@smthrs/time-travel"
import * as Effect from "effect/Effect"

const attemptsAt = (runId: string, seq: number) =>
  Effect.gen(function*() {
    const timeTravel = yield* TimeTravel
    return yield* timeTravel.inspect(
      { runId, frame: { lineageId: FlowEngine.Lineage.root(runId), seq } },
      {
        initial: 0,
        reduce: (count: number, entry) => entry.eventType === "flows.engine.attempt-started" ? count + 1 : count
      }
    )
  })
```

A lineage id is minted, never spelled. `FlowEngine.Lineage` is the one
constructor for it, and the engine stamps its result on every record a run
writes. For the whole path, from an executing flow to a folded answer, see the
[Quickstart](/quickstart/).

## The package at a glance

The root entry point exports the service key flat and everything else as a
namespace. Each namespace is also importable from
`@smthrs/time-travel/<Module>`.

| Export                  | What it is                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `TimeTravel`            | The service key and its layers. `replay`, `inspect`, `fork`, and `rewind`, plus the options each one takes. |
| `Frame`                 | The coordinate system: a frame, a lineage edge, and the record a forked run writes about its own origin.    |
| `TimeTravelError`       | The single failure type, discriminated by a closed `code`.                                                  |
| `TimeTravelStore`       | The persistence contract the verbs read and mutate history through.                                         |
| `MemoryTimeTravelStore` | The store held in JavaScript objects: deterministic, browser-safe, and the one every test runs against.     |
| `SqlTimeTravelStore`    | The durable store, SQLite dialect only.                                                                     |
| `EffectBoundary`        | The producer side: journal an effect so a rewind can assess it, and decode that evidence back.              |
| `CompensationHandlers`  | The contribution door: the compensations an adapter owns for the effects it performs.                       |
| `Migrations`            | The same schema as a rung on the shared migration ladder, for a composition that owns migration itself.     |

`Replay`, `Fork`, `Rewind`, `Retry`, `Recovery`, `Compensation`,
`SnapshotProjector`, `HistoryLimit`, and `EffectHandlerRegistry` are machinery
under `src/internal/`, blocked at the package's `exports` map. Recovery is
never a call: building `TimeTravel.layer` finishes or rolls back any rewind a
crash interrupted before the service accepts new work.

## Where to go next

- [Installation](/installation/): the services the layer requires, the
  import forms, and what a runnable composition adds.
- [Quickstart](/quickstart/): execute a durable run and replay it, end to
  end.
- Guides: [replay a run](/guides/replay-a-run/),
  [fork a run](/guides/fork-a-run/), [rewind a run](/guides/rewind-a-run/),
  [provide a store](/guides/provide-a-store/),
  [journal an effect boundary](/guides/journal-an-effect/),
  [compensate an irreversible effect](/guides/compensate-an-effect/), and
  [test against history](/guides/testing/).
- Concepts: [frames and lineage](/concepts/frames-and-lineage/),
  [derived state](/concepts/derived-state/),
  [effect tiers](/concepts/effect-tiers/), and
  [the rewind protocol](/concepts/rewind-protocol/).
- [Troubleshooting](/troubleshooting/): every refusal this package raises,
  what causes it, and what to change.
- [API reference](/reference/api/): every public export with its signature.

## What this release ships

Time travel is a library API in 1.0.0-rc.0, and only a library API. A program
that wants it provides `TimeTravelStore` and calls the service itself.

| Surface     | 1.0.0-rc.0                                                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The service | `replay`, `inspect`, `fork`, and `rewind` from `@smthrs/time-travel`.                                                                                          |
| CLI verbs   | None. The Smithers 0.x time-travel verbs exit 1 with a migration message; [migrating from 0.x](https://smithers.sh/docs/migration/1.0/#removed-commands) lists them.                    |
| MCP tools   | None. `replay_run`, `fork_run`, `rewind_run`, `restore_checkpoint`, `list_snapshots`, `get_timeline`, and `time_travel` answer with an `unsupported` envelope. |
| Composition | Not composed into `NodeControl`, and the CLI does not install migration block 5000.                                                                            |
