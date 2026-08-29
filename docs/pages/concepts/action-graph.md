---
description: "Content-addressed actions, explicit Effect dependencies, hermetic boundaries, and cached results: the Bazel-like properties and their current limits."
---

# Flows and the action graph

This page explains the repository’s Bazel-like properties: content-addressed actions, explicit Effect dependencies, hermetic-boundary contracts, and cached results, while distinguishing them from the static action planner that is not yet implemented.

## The graph that exists today

A flow handler defines dependencies through Effect structure:

```ts
const program = Effect.gen(function*() {
  const source = yield* readSource
  const [types, tests] = yield* Effect.all(
    [typecheck(source), runTests(source)],
    { concurrency: "unbounded" }
  )
  return yield* packageResult(types, tests)
})
```

Sequencing creates dependency edges. `Effect.all` exposes independent branches. `Action.raceAll` and `DurableDeferred.raceAll` create a persisted race result. Calling another flow creates a child execution dependency.

The graph is therefore explicit in the Effect program but discovered dynamically as the handler runs. There is no public `Node` or static graph value in this repository.

## The Bazel-like action boundary

An `Action` carries every piece a Bazel action does:

| Action property | Current representation |
| --- | --- |
| caller identity | string or canonical JSON object in `Action.idempotencyKey` |
| runtime layers | `Action.CacheEnvironment.layers` |
| authority | `Action.CacheEnvironment.capabilities` |
| declared reads/writes | action `metadata` decoded as `FileBoundary` |
| output | schema-encoded action exit and optional `BoundaryEvidence.declaredOutputs` |
| cache address | content-derived `Key`, then its SHA-256 digest in `CacheStore` |

A sealed action is reusable only when it has an idempotency key, a complete cache environment, and sufficient boundary evidence. Other work receives a run-local key and cannot share results across runs.

## Hermeticity is an evidence gate

The derived `Key` identifies an action but does not enforce hermeticity. Cache admission in `@smthrs/engine-store` additionally requires:

1. action tier `sealed`;
2. metadata that decodes as `FileBoundary`;
3. boundary mode `hard`;
4. successful `prepare` and `settle`;
5. no expected-set deviation.

The repository ships the contract and a deterministic test layer. A production host implementation that isolates declared reads, detects undeclared writes, captures declared outputs, and restores them on a cache hit is **Planned**.

Without that host layer, the durable engine can still replay an attempt within one run, but it cannot honestly populate the cross-run action cache.

## Graph planning

Resolving graph-local dependency references into digests is [`@smthrs/plan`](/api/plan). `Plan.compile` walks drafts in topological order and substitutes each dependency's already-computed key for its `Ref`/`Pending` reference, so a node's key is a function of what it consumes. The declarations and references live with the planner rather than in `@smthrs/keys`, which stays the single hashing transformation.

Two properties fall out and are the reason the package exists:

- **Planning performs no I/O.** Declared `effects` carry read and write *paths*, never digests. Measuring a path is run-time work.
- **Invalidation is re-keying.** An edited declaration re-keys that node and its dependent cone, and nothing else. There is deliberately no reverse-dependency index and no invalidating node visitor: content addressing subsumes both.

A plan grows rather than being replaced: `Plan.append` adds a pre-keyed subgraph at the next generation, and `PlanStore` enforces append-only with SQL triggers.

## Scheduling

Two schedulers coexist, at different altitudes.

Inside one flow body the runtime schedules **fibers**, not a persisted DAG:

- independent Effect branches can run concurrently;
- one `RunCoordinator` drain is active per execution ID in a process;
- distinct execution IDs can be driven concurrently;
- queue worker concurrency is explicit;
- run ownership prevents cross-process duplicate drivers.

Above that, `EngineStore.PlanScheduler` drives a **persisted plan**. It walks the graph, admits ready nodes under `steps`/`agents` caps ordered by priority plus one point per round waited, and dispatches each through the same `ActionPersistence` seam an ordinary action uses, so the shared cache, the workspace sandbox, attempt rows, and the fenced journal all apply unchanged. Each node settles as `built`, `clean`, `failed`, or `skipped`, and the outcome is journaled.

There is still no resource pool, critical-path analysis, or package-defined concurrency ceiling; `aspects.ts`-derived caps are supplied to the scheduler by its caller rather than read by it.

## What the plan preserves

The pre-existing contracts constrained the planner, and it keeps all of them:

- key computation stays above the encoded storage seam;
- graph-local IDs remain lookup addresses, not hash material;
- Host implementation identities and capabilities enter cache key input;
- cache hits still replay declared outputs through `StepBoundary`, and a fresh
  execution still reaches the host only through `WorkspaceSandbox`'s copy-back;
- planning executes no Host effects;
- ordinal work remains run-local.

The scheduler adds one: a node's *dispatch* key folds the plan-time key together with the boundary the host measured just before dispatch, because two runs whose input files differ declare the same graph and must not share a result.

See [implementation status](/release/support-matrix) for what is and is not shipped.
