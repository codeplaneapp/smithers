# Time travel

This page explains the inspect, fork, and rewind operations of the one
`TimeTravel` service in `@smthrs/time-travel`, and the snapshot, compensation,
and recovery machinery behind them. It also identifies the integration work the
durable engine does not yet perform automatically.

## Frames and snapshots

A `Frame` identifies a durable point by lineage and journal sequence:

```ts
import { Frame } from "@smthrs/time-travel"

const frame: Frame.Frame = {
  lineageId: "build-42/root",
  seq: 17
}
```

A `Position` pairs that frame with the run it addresses — `{ runId, frame }` —
and is the only argument every operation takes. A frame is an address into
history, never a snapshot object.

`TimeTravelStore` stores frame snapshots, run lineage, audits, compensation receipts, and archive metadata. Both memory and SQL implementations exist.

## Projection replay

`inspect` folds journal entries through a caller-provided projection. This reconstructs derived state; it does not execute a flow handler:

```ts
const timeTravel = yield* TimeTravel

const count = yield* timeTravel.inspect(
  { runId: "build-42", frame },
  {
    initial: 0,
    reduce: (state) => state + 1
  }
)
```

Use flow replay when the goal is to resume computation. Use projection replay when the goal is to derive a view from committed events.

## Fork

`fork` requires a terminal or inactive parent run, creates a store-level fork, and asks `Jj` to add an isolated workspace. The workspace name and path are derived from the child run id the fork mints rather than supplied, so a frame forked twice gets two lanes, and the lane is forgotten when the service is released.

The SQL store copies the parent's versioned engine state without terminal
result or cancellation fields and clones its attempt rows. The fork can
therefore be claimed and driven after engine layers restart. The existing
`flows_time_travel_edges` row remains the lineage source of truth.

Run state and attempts are not currently versioned by journal frame. A fork
uses the parent's current persisted snapshot and attempts; automatic
frame-addressed engine snapshots remain planned integration.

A cloned attempt row is addressed by its sealed cache key, and a cache key
computed under an undeclared `Action.CurrentCacheEnvironment` is scoped to
the execution that produced it (see [step keys](step-keys.md)). A fork
therefore replays its parent's sealed attempts only when the composition
declares its environment through `Action.layerCacheEnvironment`. Without a
declaration the fork re-executes those actions rather than reusing rows it
cannot prove were produced under the same layers and capabilities. The
declaration is complete only when `Kernel.make` also receives
`options.cacheEnvironment`; a capability list alone deliberately leaves the
identity run-local.

## Effect boundaries and compensation

`EffectBoundary.guard` records intent and outcome around an external effect. Records classify the effect as `sealed`, `compensable`, or `irreversible`, and track `intended`, `succeeded`, or `unknown` status.

Behind the service, an effect-handler registry maps effect kinds to assessment and rollback handlers, classifies suffix records, invokes eligible handlers, and returns receipts. Unknown or irreversible effects can block a rewind. None of it is a caller parameter — `EffectBoundary` is the only half of that contract you touch, from the producer side.

## Rewind protocol

`rewind`:

1. claims and activates an inactive pending or suspended run,
2. records an audit and rate-limit decision,
3. loads journal entries after the target frame,
4. checks descendant lineage,
5. assesses and compensates external effects,
6. restores the Jujutsu workspace,
7. archives and truncates the suffix atomically,
8. records completion or a recoverable failure.

Detached child policy is either `block` (the default) or `cancel`. Terminal descendants are disclosed as warnings because their external effects cannot be erased by deleting a parent suffix.

Step 8 is why recovery is not an operation: building `TimeTravel.layer` finishes or rolls back any rewind a crash interrupted, before the service accepts new work.

## Current integration boundary

The time-travel package is implemented and tested as a protocol library, but `EngineStore` does not automatically create every snapshot, lineage edge, or effect-boundary record it consumes. Applications must wire those records and migrations explicitly. Automatic end-to-end integration is **Planned**.

See [Determinism and replay](determinism-and-replay.md), [Subflows](subflows.md), and the [`@smthrs/time-travel` reference](../reference/time-travel.md).
