# Subflows

This page explains how a flow starts and waits for another registered flow in the current engine. It covers attached parent/child execution, not a general detached flow graph.

## Attached child execution

A flow handler can execute another flow with an explicit child execution ID:

```ts
const childResult = yield* Compile.execute(
  { target: "server" },
  { executionId: `${parentExecutionId}/compile` }
)
```

When `EngineStore` detects that execution inside a running flow, it:

1. creates or reuses a separate child run,
2. stores the parent execution ID on that child,
3. suspends the parent while the child is incomplete,
4. resumes the parent after the child reaches a terminal result.

The child has its own run ownership, journal entries, action attempts, and payload/result schemas. Re-executing the parent observes the persisted child result instead of starting another child with the same execution ID.

## Identity requirements

Every flow execution must have either:

- an explicit `executionId`, or
- a flow-level `idempotencyKey` from which `Flow.executionId` can derive one.

For child flows, an explicit ID derived from stable parent input is usually easier to audit. An ID derived from timing, randomness, or branch scheduling is not replay-safe.

## Interruption

The engine contract exposes `interrupt` and `interruptUnsafe`. The memory engine lets `interrupt` resume cooperatively so flow cleanup can run, while `interruptUnsafe` interrupts its fiber. `EngineStore` currently maps both operations to the same durable interruption path and does not implement structured child cancellation. Do not rely on durable parent interruption to cancel descendants automatically.

## Detached children and lineage

The public flow API does not currently expose a first-class detached-child option. The time-travel store can represent `child`, `fork`, and `continuation` lineage edges, and rewind has policy for detached descendants, but EngineStore does not automatically record all of that lineage.

First-class detached execution, automatic durable lineage, and structured parent cancellation policy are **Planned**.

See [Durable execution model](durable-execution-model.md), [Time travel](time-travel.md), and the [`@smthrs/flow` reference](../reference/flow.md).
