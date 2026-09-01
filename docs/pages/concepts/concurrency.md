---
description: "Concurrency that exists today: handler fibers, bounded fan-out, priority, durable races, queue workers, and run exclusion."
---

# Concurrency

This page explains concurrency that exists in flow handlers, actions, durable queues, ownership, and journal admission. It separates those mechanisms from the planned static graph scheduler.

## Handler concurrency

Use Effect combinators to express dependencies and concurrency:

```ts
const [checked, tested] = yield* Effect.all(
  [typecheck, test],
  { concurrency: 2 }
)
```

The enclosing flow handler does not complete until both effects complete. Error and interruption behavior follows `Effect.all`; Smithers does not add an implicit “continue unrelated nodes” policy.

Actions receive ordinals from a counter scoped to the action's **name**, not from one per-run counter bumped in fiber-arrival order (issue #73), and the name is folded into the ordinal step key. Two distinct actions running concurrently, `Effect.all([chargeCard, sendEmail], { concurrency: "unbounded" })`, therefore keep their identities no matter how a replay interleaves them. What remains order-sensitive: repeated invocations of the *same* action in one run are numbered in allocation order, and changing branch structure before an action can still change which invocation occupies which number. For cross-run cache reuse, or to pin identity across concurrent invocations of one action, declare a cache key input instead of relying on an ordinal.

## Bounded fan-out and quarantine

`@smthrs/patterns` supplies the two join policies a fan-out needs.

`Bounded.all(members, { concurrency, priority? })` splits a named record into batches of `concurrency` and sequences the batches, so a plan states how many calls can be in flight. Members are ordered by priority, highest first, with declaration order breaking a tie. A member that carries its own `Node.priority` keeps it; the rest inherit the container's. Priority never enters key material, so raising it does not invalidate a cached step. `Bounded.run` is the Effect form and follows `Effect.forEach`: the first failure interrupts the members still in flight.

`Quarantine.all(members, { policy })` chooses what a failing member does to its siblings. Under `quarantine` each member gains a recovery arm and every member settles as an explicit envelope, `{ _tag: "Succeeded", member, value }` or `{ _tag: "Quarantined", member, error }`, so the join returns a record of outcomes and no sibling is interrupted on another's behalf. Nesting the successful value is what keeps a user value of any shape, including the marker's own shape, from being read as protocol metadata. Under `halt` the join is the ordinary one and preserves raw successful values. `Quarantine.run` mirrors both, and `Quarantine.settle(result)` unwraps the successful values and fails `PatternError { code: "quarantined" }` listing the isolated members when the caller wants halt-after-join.

Quarantine isolates typed failures. A defect and an interruption still propagate, because neither is a result the flow declared.

## Priority

`Node.priority(node, n)` attaches a scheduling priority. A higher number goes first when more work is ready than the run has capacity for. Both node models carry it: `@smthrs/core` records it as the `Annotations.Priority` annotation for the plan-time surface `@smthrs/patterns` reads, and `@smthrs/plan` records it as a plain JSON field on the AST, because a stored plan has to keep it and a `Context` value is not serializable.

`Graph.build` copies the value onto `NodeDraft.priority`, `Plan.compile` copies that onto the plan node, and `PlanScheduler` orders ready nodes by declared priority plus one aging point per capacity-constrained pass, so a low-priority node still runs rather than starving. Inheritance is lexical: a node takes the priority of the nearest enclosing node that declares one, and a node that declares its own keeps it.

Priority changes latency and nothing else. It never enters key material, so raising it reorders work without invalidating a cached step. It does enter the plan digest, because the ordering is part of what a human approves.

## Durable races

`Action.raceAll` and `DurableDeferred.raceAll` preserve the flow abstractions while racing alternatives. They are distinct from a planned graph-level race node. Use them only when every loser has acceptable interruption semantics.

## Queue workers

`DurableQueue.worker` accepts a concurrency limit for persisted-queue processing:

```ts
const WorkerLayer = DurableQueue.worker(
  CompileQueue,
  ({ target }) => compile(target),
  { concurrency: 4 }
)
```

Queue persistence comes from Effect’s `PersistedQueueFactory`. The flow offers an item with a deterministic id, awaits a durable deferred token, and resumes after a worker records the handler exit.

## Run and attempt exclusion

Two storage protocols prevent concurrent duplicate ownership:

- `RunStore` fences a run using a claim, owner identity, and heartbeat.
- `AttemptStore` claims an individual `(runId, stepKey, attempt)` before an action executes.

The protocols reject mismatched owners and stale snapshots. They do not provide distributed locking for arbitrary application resources.

## Journal admission

The SQL journal queue provides optimistic, non-blocking admission through `emitLossy` for telemetry, where loss is acceptable. Capacity limits bound queued events and bytes; excess input is rejected instead of waiting indefinitely. Lifecycle events use `emitDurable`, which commits inline and blocks until it does.

Sequence allocation may produce holes when a reserved event is rejected or a transaction fails. Consumers must treat sequence numbers as ordered cursors, not contiguous counters.

## Planned scheduler

A resource-aware action scheduler, per-node concurrency ceilings, and first-class graph race/failure policies are **Planned**. Today, compose these constraints with Effect primitives and external worker configuration.

See [The action graph](/concepts/action-graph), [Journal](/concepts/journal), and [Failure and retry](/concepts/failure-and-retry).
