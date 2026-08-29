---
description: "The replay contract: what a flow body may do, how an action is memoized, and how replay differs from a time-travel projection."
---

# Determinism and replay

This page defines the replay contract for flow authors and engine implementers. It covers current handler re-execution, action memoization, suspension, and the distinction between engine replay and time-travel projection.

## The replay function

Conceptually, a handler should behave like:

```text
result = handler(encoded payload, recorded durable boundaries)
```

On resume, the durable engine:

1. claims the run;
2. decodes the original payload;
3. starts the registered handler from the top;
4. returns stored attempts and deferred completions at known boundaries;
5. dispatches at the first boundary with no recorded result.

Control flow is re-evaluated. It is not restored from a JavaScript stack snapshot.

## Deterministic flow code

Code between durable boundaries must produce the same control flow when given the same payload and recorded values. Do not use:

- `Date.now()` or a process clock directly;
- `Math.random()` or unseeded random values;
- global mutable state;
- unordered external reads;
- changing environment variables;
- Host operations outside an `Action`.

Instead, run nondeterministic or effectful work inside a recorded action:

```ts
const ReadConfig = Action.make({
  name: "config/read",
  success: Schema.String,
  tier: "sealed",
  idempotencyKey: {
    operation: "config/read/v1",
    path: "/workspace/config.json"
  },
  execute: readConfigEffect
})
```

The output may be nondeterministic. Replay safety comes from recording its encoded exit, not from requiring the output itself to be predictable.

## Action identity

For a sealed action with an `idempotencyKey`, the flow engine computes a cache key. A **string** is namespaced by the action name and declared schemas. An **object** is caller-owned canonical JSON and remains stable across action renames. The engine adds runtime environment and boundary facts separately.

Sealed actions without a cache key input, plus compensable and irreversible actions, use an ordinal allocated from a counter scoped to the action's name, with the name folded into the key (issue #73). Concurrent actions of different names are therefore stable under any interleaving. Repeated invocations of one action are numbered in allocation order, so changing control flow before such a boundary can still change which invocation occupies which ordinal. Prefer stable cache key inputs for replayable reads.

## Suspension

When a durable deferred has no stored exit, `DurableDeferred.await` marks the flow suspended and interrupts the current flow fiber. `Flow.intoResult` converts the suspension interrupt into a `Flow.Suspended` value. The durable driver stores `suspended` and releases ownership.

Completing the deferred persists its first result, records and flushes a journal event, then schedules a claim-gated wake. Re-execution reads the completion and proceeds.

## Races

`DurableDeferred.raceAll` checks for an already persisted winner before running a new `Effect.raceAll`. The first exit is written to a named deferred, so replay returns that exit instead of choosing again from new timing.

The current public API does not expose a separate durable record for every losing branch. Do not assume loser outcomes are individually replayable.

## Replay versus time-travel projection

Two APIs use “replay” differently:

- `EngineStore` replay re-runs a registered flow handler and returns stored boundaries.
- `TimeTravel.inspect` is read-only. It folds committed journal entries up to a `Frame` and optionally resolves cache values. It never invokes a flow handler or action dispatcher.

The latter is suitable for rebuilding a view or assessing a frame. It is not an engine resume.

## Source changes

There is no flow-source digest check. Existing action keys and ordinal positions determine what reuses recorded state after a code edit:

- changed cache key input → new action result;
- unchanged cache key input → existing result;
- changed control flow around ordinal actions → potentially different ordinal mapping;
- changed flow schemas → stored payload or result decoding may fail as a defect.

Version flow tags, action bodies, and schemas deliberately when compatibility changes.

## Related

- [Durable execution model](/concepts/durable-execution-model)
- [Step keys](/concepts/step-keys)
- [Time travel](/concepts/time-travel)
- [Testing](/guides/testing)
