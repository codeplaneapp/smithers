---
title: "Drive a plan to completion"
description: "Record a plan, supply a node executor, run the graph, and read every node's outcome: admission caps, rebase budgets, conflict strategies, and reconciliation verdicts."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine-store/docs/guides/drive-a-plan.md"
---

`PlanScheduler` drives a persisted [`@smthrs/plan`](https://plan.smithers.sh/reference/api/) plan. It owns
identity, admission, caching, and journaling, and deliberately owns nothing
about what a node means: turning a node into work is the one seam you supply.

## Supply an executor

`NodeExecutor` is that seam. It receives a `NodeInput` and returns whatever the
node produces:

```ts
import { PlanScheduler } from "@smthrs/engine-store"
import * as Effect from "effect/Effect"

const executor = PlanScheduler.layerExecutor({
  execute: (input) =>
    Effect.succeed({
      node: input.node.id,
      attempt: input.attempt,
      inputs: input.inputs.map((resolved) => resolved.value)
    })
})
```

`NodeInput` carries the `PlanNode`, the `attempt` number, the `boundary` this
dispatch was keyed under, and the node's material `Ref` inputs already resolved
through the same projection the key digests. Ordering dependencies and
unprojected sibling fields are deliberately absent: an executor may only see
data the key folds, or a cached settlement could be served for an execution that
consumed something else.

## Build the scheduler and run the plan

```ts
const scheduler = PlanScheduler.layer({
  runId: "plan-1",
  owner,
  sourceId: "planner",
  concurrency: { steps: 8, agents: 2 },
  rebaseLimit: 3
})
```

`concurrency.steps` caps leaf execution and `concurrency.agents` caps the agent
subset within it. Both default to unbounded and both floor at one, because a cap
of zero admits nothing and a round that admits nothing settles nothing. Invalid
bounds are rejected at construction: both must be positive safe integers, and
`rebaseLimit` a non-negative one.

The service has three members:

```ts
interface Service {
  readonly record: (plan: Plan) => Effect<RecordResult, SchedulerError, PlanStore | Journal>
  readonly append: (plan: Plan) => Effect<void, SchedulerError, PlanStore | Journal>
  readonly run: (plan: Plan) => Effect<Report, SchedulerError, Requirements>
}
```

`record` persists generation 0 and journals `plan-recorded`. `append` persists
the newest generation and journals `subgraph-appended`. `run` walks the graph
and returns a `Report`.

## Read the report

`Report` carries the `planId`, its `digest`, one `Settlement` per node, the
`results` by node id, the reconciliation `verdicts`, and the ids of any merge
nodes a `stop-merge` conflict appended.

Each `Settlement` names the `planKey` (a pure function of declarations), the
`dispatchKey` actually dispatched under, the `attempts` and `rebases` spent,
and one of five outcomes:

| Outcome    | Meaning                                                                     |
| ---------- | --------------------------------------------------------------------------- |
| `built`    | The node executed and succeeded.                                            |
| `clean`    | The shared cache served it and nothing ran.                                 |
| `failed`   | The node executed and failed, or reconciliation failed it.                  |
| `skipped`  | It never dispatched: its cone failed, or `stop-merge` stopped it.           |
| `deferred` | A selection guess postponed it. It never dispatched and wrote no cache row. |

Every settlement is journaled as `node-settled`. A `deferred` node is never
reported as passed, and is a debt a later guess-free pass repays.

## Why the dispatch key is not the plan key

The dispatch key folds the plan-time node key together with the boundary the
host measured immediately before dispatch. Two runs whose input files differ can
declare the same graph, and serving one the other's result is exactly the
staleness the boundary exists to prevent.

Source paths, read by the plan and written by nothing in it, are measured once
before the first dispatch and pinned for the whole run. Produced paths are
measured after their producer settles. That is the torn-run rule: a rebase
re-observes our own outputs, never the world.

Ready work is ordered by declared `priority` plus one point per round waited, so
priority changes latency without permitting starvation.

## Handle a conflict

The runtime conflict strategies ride the plan's pair annotations:

- **delay and rebase** holds the dependents and re-executes against the newly
  recorded base. The re-measure re-keys, so it is a new attempt rather than a
  retry of one identity. It is journaled as `node-invalidated` and bounded by
  `rebaseLimit`, because an unbounded rebase loop is a livelock with good
  manners.
- **stop and merge** stops the loser and appends a merge node to the same plan
  as an ordinary elaboration, with no rebase budget of its own: a lane that
  loses a landing race restarts or fails rather than rebasing.

A conflict neither strategy absorbs goes to `Reconciliation`.

## Install a reconciler

`Reconciliation` answers a `Deviation` or a `Conflict` with a `Verdict`:

```ts
import { Reconciliation } from "@smthrs/engine-store"

const reconciler = Reconciliation.layerDefault
```

`layerDefault` is deterministic, in this order of preference:

- `Reorder` when every undeclared path is one another plan node declares it
  writes. That is a real dependency the declaration missed, made explicit.
- `FactorOut` when another node in the same run deviated on exactly the same
  paths. Content addressing collapses two identical extracted steps to one key
  by itself, so the verdict is a record and a hint.
- `Fail` otherwise, because a deviation nothing explains is genuinely wrong. A
  conflict the runtime strategy could not absorb always fails here: choosing a
  winner between two landings is a semantic judgement this default does not
  have the material to make.

The scheduler attributes every deviation on a journal page before judging any of
it, so two steps that produced the same undeclared paths both see each other.
Deviating identically is a symmetric fact, and which of the pair the journal
happened to list first must not decide the verdict.

`Reconciliation.layer(service)` installs your own. Pluggability here is
dependency injection at the owning seam; there is no hook kernel. A model-backed
reconciler is a different `Layer` and lives in the agent packages: this package
has no model dependency and must not grow one.

## What a SchedulerError is, and is not

`SchedulerError` is a refusal the scheduler itself raises, with a `code` of
`boundary_unavailable`, `key_uncomputable`, `elaboration_failed`, or
`store_failed`. A node's own failure is not one of these: the run continues and
the report says `failed`.

## Related

- [Defer work with selection](/guides/defer-work-with-selection/): what a
  `deferred` outcome means and how the debt is repaid.
- [Cache admission](/concepts/cache-admission/): why a node settles `clean`.
