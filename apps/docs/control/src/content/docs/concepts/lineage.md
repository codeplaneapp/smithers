---
title: "Run lineage"
description: "The one vocabulary four ancestry records project onto: child, fork, and continuation, where each is written, which record wins, and how watch derives exactly one lineage delta per edge."
sidebar:
  order: 5
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/control/docs/concepts/lineage.md"
---

A run's ancestry is recorded by whoever created it, in four different places:
the run row's `parent_run_id`, `lineage_id`, and `round_ordinal` columns; the
`flows_run_parents` edge a spawn writes; the `created` and `handed-off` run
decisions the engine journals; and the `fork-created` marker time travel writes
on a forked child.

`Lineage` owns the one vocabulary all four project onto, and the pure functions
that do the projecting, so the durable runtime and the watch stream cannot
disagree about what a run's ancestry means.

## The vocabulary

`Origin` has three values, and a run with no ancestor has no origin at all:

| Origin         | What it means                                  |
| -------------- | ---------------------------------------------- |
| `child`        | Another run spawned it.                        |
| `fork`         | It was branched off a parent frame.            |
| `continuation` | It is a later round of one trampoline lineage. |

A rewind is deliberately absent. It truncates a run in place and creates none,
so it is a thing that happened to a run rather than a reason a run exists.

`Lineage.originOf` is the derivation, and it is pure:

```ts
import * as Lineage from "@smthrs/control/Lineage"

Lineage.originOf({ parentRunId: "run-1" }) // "child"
Lineage.originOf({ parentRunId: "run-1", forked: true }) // "fork"
Lineage.originOf({ parentRunId: "run-1", roundOrdinal: 2 }) // "continuation"
Lineage.originOf({}) // undefined
```

A fork wins over a plain child because a fork records `parent_run_id` too.
Without the marker, every fork would be reported as an ordinary child.

## What a run summary reports

`RunSummary` carries all of it under one vocabulary:

| Field          | Source                                                              | Meaning                                                                                                   |
| -------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `parentRunId`  | `flows_runs.parent_run_id`, else the `flows_run_parents` spawn edge | The run this one branched from: its spawner, the run it was forked off, or the previous trampoline round. |
| `lineageId`    | `flows_runs.lineage_id`                                             | The trampoline lineage this run is a round of.                                                            |
| `roundOrdinal` | `flows_runs.round_ordinal`                                          | Which round. Absent means a lineage of one, read as round 0 of itself.                                    |
| `origin`       | derived                                                             | `child`, `fork`, or `continuation`.                                                                       |

The projection reads both recording places because the engine uses both.
`parent_run_id` is the trampoline chain: the round before this one. A run that
another run _spawned_ writes nothing in its own row, because the edge lives in
the `flows_run_parents` graph that cycle detection walks. A projection that
read the column alone would report every child of every run as an orphan.

The column wins when a row has both. That is round 1 of a run that was itself
spawned: its nearest ancestor is the round before it.

## The delta `watch` derives

Three journal entries disclose an edge, and each names a different pair:

| Entry                                                                              | Producer                                    | Delta                                                                     |
| ---------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| `flows.engine.run-decision` with `decision: "created"` at round 0 or with no round | [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/) | `{ runId, parentRunId, origin: "child" }`                                 |
| `flows.engine.run-decision` with `decision: "handed-off"`                          | [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/) | `{ runId, parentRunId, lineageId, roundOrdinal, origin: "continuation" }` |
| `flows.time-travel.fork-created`                                                   | [`@smthrs/time-travel`](https://time-travel.smithers.sh/reference/api/)   | `{ runId, parentRunId, origin: "fork" }`                                  |

The handoff is what carries a trampoline, and a continuation round's own
`created` decision is deliberately skipped. The engine journals both in one
transaction: it creates the next round with
`{decision: "created", lineageId, roundOrdinal, parentExecutionId}` and records
`{decision: "handed-off", nextExecutionId}` on the round that finished. Both
name the same pair, so deriving from both would report one run as a `child` of
its predecessor on one entry and a `continuation` of it on the other.

The handoff is the one kept, because it reaches a consumer watching the run
that hands off, which is the run an operator is already following when a
trampoline advances. Exactly one delta therefore names each continuation round,
whichever round of the lineage the consumer is watching.

```ts
Lineage.derive({
  sequence: 12,
  kind: Lineage.runDecisionEventType,
  runId: "run-1",
  occurredAt: 1_700_000_000_000,
  payload: { decision: "handed-off", nextExecutionId: "run-2", lineageId: "run-1", roundOrdinal: 1 }
})
// {
//   sequence: 12,
//   kind: "control.run.lineage",
//   runId: "run-1",
//   occurredAt: 1700000000000,
//   payload: { runId: "run-2", parentRunId: "run-1", lineageId: "run-1", roundOrdinal: 1, origin: "continuation" }
// }
```

Everything else derives nothing. This is a projection over entries the control
plane did not write, so an entry it does not recognize is not an error, and a
`created` decision that names no parent discloses no ancestry.

## Selecting on lineage

`list` filters on the same fields, so an operator can ask both ancestry
questions:

```ts
const children = yield * control.list({ _tag: "runs", filters: { parentRunId: "run-17" } })
const rounds = yield * control.list({ _tag: "runs", filters: { lineageId: "run-17" } })
```

The durable listing covers every row in `flows_runs`, not only the runs the
control plane launched itself. A child, a fork, and a later trampoline round
are all created by the engine straight into the run store, and a plane that
listed only its own launches could not answer what a run spawned. Runs the
plane launched keep launch order; the rest follow in creation order. A run
whose `state_json` is not a control summary is projected from the run row's own
columns instead, with the engine's `flowName` as its `flowId`.

## Where to go next

- [Find runs and page through them](/guides/list-runs/): the filters as a
  task.
- [Watch a run's events](/guides/watch-a-run/): where the delta arrives.
- [Time travel on smithers.sh](https://smithers.sh/docs/concepts/time-travel/): what makes a fork.
