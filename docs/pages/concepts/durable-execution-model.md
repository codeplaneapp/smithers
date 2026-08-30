---
description: "What survives process loss, what is replayed, and where durability begins and ends."
---

# Durable execution model

This page defines the runtime model implemented by `@smthrs/engine`, `@smthrs/engine-store`, and `@smthrs/journal`. It explains what survives process loss, what is replayed, and where the current durability boundary stops.

## Core terms

- A **flow** is a typed definition plus a registered Effect handler.
- An **execution** is one flow invocation identified by `executionId`.
- An **action** is a schema-encoded effect boundary with a stable key, attempt number, and durability tier.
- A **run row** stores execution status, ownership, encoded payload, and encoded result.
- An **attempt row** stores the state and outcome of one `(run, step-key digest, attempt)` tuple.
- A **suspension** is a non-terminal result that releases run ownership until a wake resumes the handler.

## The lifecycle

```text
pending → running → completed
                  ↘ failed
                  ↘ suspended → running
                  ↘ cancelled
```

Only `running` runs have an owner. A driver reads the exact persisted snapshot, claims it, activates the claim, and maintains a heartbeat. Moving to `suspended` or a terminal status clears owner and heartbeat atomically.

A run that reaches a terminal status also ends the children linked to it. The same transaction that writes `completed` or `failed` cancel-requests every attached descendant and leaves every detached one running, so a crash cannot commit a finished parent over a live child. See [Subflows](/concepts/subflows).

All start and wake paths enter the same keyed `RunCoordinator`, so concurrent callers either join one local drain or race through the same database claim. A stale owner may be replaced only after its heartbeat is at least 30 seconds old. By default the expired lease is the whole answer, so a fresh process reclaims the runs of an owner that died without releasing them. A deployment that can probe the owner supplies `EngineStore.Options.isAlive` and the takeover waits for that probe to report the owner gone.

## Replay from the top

The registered handler is not serialized. On resume, the engine invokes it from the beginning with the persisted payload. Each durable boundary decides whether to return recorded state or do new work:

```ts
const handler = () =>
  Effect.gen(function*() {
    const first = yield* firstAction       // recorded attempt on replay
    const signal = yield* DurableDeferred.await(gate) // suspends until completed
    const frontier = yield* frontierAction // runs after the wake
    return `${first}/${signal}/${frontier}`
  })
```

This shape is adapted from the repository’s durable replay test. The local statement before the deferred executes again, but `firstAction` does not dispatch again; its recorded attempt is returned. After the deferred is completed and the run is reclaimed, `frontierAction` becomes live.

See [determinism and replay](/concepts/determinism-and-replay) for authoring rules.

## What is persisted

With `EngineStore`, the following can outlive the driving fiber:

- encoded flow payload and result;
- run status, claim, owner, and heartbeat;
- action attempts, checkpoints, outcomes, errors, and metadata;
- journal entries;
- shared cache entries.

Deferred completions and clock deadlines pass through `DurableEngineState`.
`DurableEngineState.layer` persists them in the journal-migrated SQL schema;
`layerMemory` is available for deterministic tests. Re-registering a flow
re-arms every pending absolute deadline and re-delivers claim-gated wakes for
stored completions.

Flow registrations, active fibers, the flow handler function, and the run coordinator’s active map stay in memory. A restarted process must reconstruct layers and register handlers before it can resume stored executions.

## Execution IDs

`Flow.execute` takes its ID from the first of three sources that has one:

1. an explicit `executionId` supplied by the caller;
2. an `idempotencyKey(payload)` declared by the flow;
3. the ambient `Flow.CurrentExecutionIds` source.

The default source derives the ID from the flow tag and the payload's RFC 8785 canonical form, so `yield* Flow.execute(payload)` runs without naming an ID and a re-drive of the same invocation lands on the same execution. It dies with `Flow.ExecutionIdRequired` before the engine is invoked when the payload has no canonical form.

A host for which two equal payloads are two unrelated pieces of work installs its own source:

```ts
const layer = Flow.layerExecutionIds({
  mint: (flow, payload) => Effect.map(currentSessionId, (session) => `${session}/${flow._tag}`)
})
```

Reusing an ID with a different flow tag or encoded payload is rejected as a defect by the durable driver.

## Durability is boundary-based

Ordinary TypeScript and Effect combinators are not individually journaled. Durability attaches at:

- `Action`;
- `DurableDeferred`;
- durable clocks;
- durable queues built from deferreds and Effect’s persisted queue;
- child flow execution, attached or detached;
- explicit journal or time-travel effect boundaries.

Calling an API, reading the filesystem, generating randomness, or consulting wall-clock time outside one of those boundaries can make replay diverge. Host services make these dependencies injectable, but injection alone does not record their results.

## Current phase model

The implemented library has definition, execution, and replay:

1. definitions and layers are assembled in memory;
2. the handler executes under a flow engine;
3. a resume re-executes it against stored boundaries.

A separate discovery phase, pure static planning phase, and serializable action-graph builder are **Planned**. The current runtime does not expose a plan value that enumerates every future action or cache hit before execution. See [flows and the action graph](/concepts/action-graph).

## Related

- [Execution and data flow](/architecture/execution-data-flow)
- [Journal](/concepts/journal)
- [Failure and retry policy](/concepts/failure-and-retry)
- [Subflows](/concepts/subflows)
- [`@smthrs/engine-store` reference](/api/engine-store)
