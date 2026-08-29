---
description: "How a flow starts another flow, what happens to the child when the parent ends, and how lineage is recorded."
---

# Subflows

This page explains how a flow starts another registered flow, what happens to that child when the parent ends, and how a fire-and-forget child is started, steered, and collected later.

Every subflow is a separate durable run. It has its own run row, its own ownership claim, its own journal entries, and its own action attempts. Nothing about a subflow is a fiber.

## Attached children

A flow handler executes another flow with an explicit child execution id:

```ts
const childResult = yield* Compile.execute(
  { target: "server" },
  { executionId: `${parentExecutionId}/compile` }
)
```

When `EngineStore` sees that execution inside a running flow, it:

1. records a durable parent edge in `flows_run_parents`, rejecting a cycle inside the same transaction,
2. creates or reuses the child run, storing the parent execution id on it,
3. suspends the parent while the child is unsettled,
4. resumes the parent once the child reaches a terminal result.

Re-executing the parent observes the persisted child result instead of starting a second child under the same execution id.

## What happens to a child when its parent ends

Each child records `onParentExit` for itself when it is spawned, and the parent applies it. There are two values:

| Value | Recorded when | The parent's exit |
| --- | --- | --- |
| `cancel` | the caller waits for the child's result | The child is cancel-requested in the parent's own terminal transaction. |
| `detach` | the caller discards the result | The child is left running and reported in the journal. |

The default is `cancel`, including for a child row written before the field existed. An attached child exists because something is waiting for it, so a parent that stops waiting (because it completed, failed, or was cancelled) leaves nothing behind.

Three things are governed separately:

- **Terminal exit.** A run that settles `completed` or `failed` walks the durable edge table, cancel-requests every attached descendant transitively, and stops at each detached child without walking its subtree. The requests commit in the same transaction as the parent's terminal row, so a crash cannot leave a completed parent over a live child. The walk journals `child-policy-applied` with the runs it cancelled and the runs it left alone, and journals nothing when the run had no linked child.

  The parent writes a durable cancel REQUEST, not the child's terminal row. Ownership fencing forbids a parent writing state for a run another driver owns, so the child's own driver settles the request at its next boundary, and a child whose owner is gone is settled by the stale-run sweep once that owner's lease expires. Nothing external is called: the request and the settlement are both engine work.
- **Cancellation.** A cancelled run cascades to every linked descendant, detached ones included. An operator who cancels a run is asking for the subtree to stop, and a child does not opt out of that.
- **Handoff.** A round that hands off to the next round of its lineage is not an exit. The lineage continues, so its children continue with it.

A child linked to a parent that had already exited inherits the same decision at admission: the parent's walk ran before the edge existed, so the child applies its own recorded policy inside the transaction that made it a child.

## Detached children

`@smthrs/agent` exposes the detached lifecycle as three ordinary flows a cell calls by name. `ChildFlows` declares `agent/spawn`, `agent/send`, and `agent/await`, and `EngineChildren` implements them over a durable engine:

```ts
import { EngineChildren } from "@smthrs/agent"

const children = EngineChildren.layer({ flows: [Reviewer, Builder] })
```

- `spawn` starts the named flow as a discarded execution under the calling run, which is what records `onParentExit: "detach"`. It answers once the child's run row exists durably, so the id it returns names something a later process can find. The child's id is derived from the caller and the label (`<parent>/child/<label>`), so a re-driven parent spawns the same child rather than a second one, and two concurrent children need two labels.
- `await` reads the child's settled result out of the run store. It works from another engine, another process, and a later incarnation, because it reads durable state rather than a fiber. It waits by re-reading the child on an interval rather than parking the caller, so the calling round stays open while it waits.
- `send` steers the child through `Control.steer`, which admits a durable `human-steer` message the child drains at its next turn boundary. The message id is the calling step's key: the parent's execution id folded with an ordinal counted inside the enclosing dispatch. A re-driven round re-derives the same key, so the control plane admits the message once; and because the ordinal is scoped to the dispatch, a send made after a park cannot take the number of a send the engine replayed instead of running. The message itself is replay-stable too: `send` reads its timestamp inside a sealed step, so a re-drive submits the message it submitted before rather than a new one under a used key. `send` then answers from the receipt. `Accepted` and `AlreadyApplied` both mean the child has the message exactly once and report `delivered: true`. Any other receipt fails the call with `ChildError { code: "failed" }`, because the message was not admitted: `Conflict` names the key that already carries different words, and `Terminal` says the child ended first.

`EngineChildren` depends on three services and no engine internals: `FlowRuntime` starts and polls executions, `RunStore` says whether a child exists, and `Control` steers one. It reads the child's flow name out of the one public field `RunStore.RunRow.stateJson`, projected to that single key.

A host without a durable engine supplies `ChildFlows.makeNoop`, whose refusals (`ChildError { code: "unsupported" }`) the cell can see and route around. `ChildError` reports `not_found` for a flow this host does not run, for a start attempt that ended without creating a run row, and for a child id that names nothing; `failed` for a child that ended without a value, for a start that neither created a run nor ended inside its budget, and for a control plane that refused the message, whether by failing outright or by answering with a receipt that is not a delivery.

## Identity requirements

Every flow execution needs either an explicit `executionId` or a flow-level `idempotencyKey` `Flow.executionId` can derive one from. For a child, derive the id from stable parent input. An id derived from timing, randomness, or branch scheduling is not replay-safe.

## Interruption

The engine contract exposes `interrupt` and `interruptUnsafe`. The memory engine lets `interrupt` resume cooperatively so flow cleanup can run, while `interruptUnsafe` interrupts its fiber. The durable engine has one cancellation path: `interrupt` is durable, and `interruptUnsafe` fails with `unsafe_interrupt_unsupported` rather than forcing a stop without cleanup. That one path, and that path cascades over `flows_run_parents`: a cancellation observed from durable state (another CLI, another worker, a lease recovery) reaches every linked descendant, whether or not the observing process ever spawned them.

## Lineage

The parent edge is durable, so lineage survives a restart and is visible to every owner process. The time-travel store represents `child`, `fork`, and `continuation` edges as one tree: fork edges come from its own edge table, child edges from the parent journal's spawn record, and continuation edges from the `handed-off` run decision of the round that advanced. Rewind has policy for detached descendants. The control plane projects engine-created lineage back onto its run summaries and filters: `Control.list` answers `parentRunId` and `lineageId` filters, and `Control.watch` carries a derived `control.run.lineage` event.

`examples/src/36-detached-children.ts` is this page in runnable form: a parent that spawns a detached child and completes, and a second engine over the same database file that collects the child.

See [Durable execution model](/concepts/durable-execution-model), [Time travel](/concepts/time-travel), the [`@smthrs/flow` reference](/api/flow), and the [`@smthrs/engine-store` reference](/api/engine-store).
