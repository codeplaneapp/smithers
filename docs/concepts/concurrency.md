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

The enclosing flow handler does not complete until both effects complete. Error and interruption behavior follows `Effect.all`; Smithers Flows does not add an implicit “continue unrelated nodes” policy.

Actions receive ordinals from a counter scoped to the action's **name**, not from one per-run counter bumped in fiber-arrival order (issue #73), and the name is folded into the ordinal step key. Two distinct actions running concurrently — `Effect.all([chargeCard, sendEmail], { concurrency: "unbounded" })` — therefore keep their identities no matter how a replay interleaves them. What remains order-sensitive: repeated invocations of the *same* action in one run are numbered in allocation order, and changing branch structure before an action can still change which invocation occupies which number. For cross-run cache reuse, or to pin identity across concurrent invocations of one action, declare a cache key input instead of relying on an ordinal.

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

See [The action graph](action-graph.md), [Journal](journal.md), and [Failure and retry](failure-and-retry.md).
