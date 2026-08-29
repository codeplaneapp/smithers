---
description: "Frame-addressed history behind one injectable service: inspect, fork, and rewind."
---

# @smthrs/time-travel

Frame-addressed history behind ONE injectable service: inspect, fork, rewind. It reads and writes through public journal, cache, host, and time-travel store contracts.

```ts
import { TimeTravel } from "@smthrs/time-travel"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const timeTravel = yield* TimeTravel
  const position = { runId: "build-42", frame: { lineageId: "build-42/root", seq: 17 } }
  return yield* timeTravel.inspect(position, { initial: 0, reduce: (state) => state + 1 })
})
```

## Entry point

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/time-travel` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/index.ts) | any |

## Frame

[src/Frame.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/Frame.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Frame` | schema + type | `lineageId` plus journal `seq` |
| `LineageEdge` | interface | parent, child, and kind |
| `LineageEdgeKind` | const + type | `child`, `fork`, `continuation` |

## TimeTravelStore

[src/TimeTravelStore.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/TimeTravelStore.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `TimeTravelStore` | service tag | |
| `Service` | interface | snapshots, derived frame state, lineage, audits, receipts, archive |
| `snapshotAt`, `recordSnapshot` | methods | the tier-2 anchor at a frame: its jj pointer and the plan digest in force |
| `stateAt`, `attemptsAt` | methods | run state and admitted attempts AT a frame, folded from the journal rather than read off the run row |
| `Snapshot`, `AttemptRef`, `Descendants`, `Audit`, `Receipt`, `ArchiveResult`, `Fork` | interfaces | stored shapes; `Fork` carries the normalized `warnings` |
| `make`, `makeNoop`, `layerNoop` | constructors + layer | |

| Implementation | Source | Notes |
| --- | --- | --- |
| `MemoryTimeTravelStore.make`, `layer`, `MemoryState`, `JournalRecord`, `Options` | [src/MemoryTimeTravelStore.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/MemoryTimeTravelStore.ts) | deterministic tests |
| `SqlTimeTravelStore.migrate`, `make`, `layer` | [src/SqlTimeTravelStore.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/SqlTimeTravelStore.ts) | creates its tables on build |
| `Migrations.set`, `sets`, `run`, `layer` | [src/Migrations.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/Migrations.ts) | the same DDL as a rung on the shared ladder, at id block `5000` |

`SqlTimeTravelStore.migrate` creates `flows_time_travel_snapshots`, `flows_time_travel_edges`, `flows_time_travel_audits`, `flows_time_travel_receipts`, and `flows_time_travel_archive`, and indexes `meta_json.lineageId` on the journal's own `flows_journal_events` so a lineage-filtered read is not a full run scan.

## TimeTravel

[src/TimeTravel.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/TimeTravel.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `TimeTravel` | service key | tag `@smthrs/time-travel/TimeTravel`; `yield* TimeTravel` is the whole surface |
| `TimeTravel.layer` | layer | needs only `TimeTravelStore`, `Journal`, `RunStore`, `CacheStore`, and `Jj` |
| `make` | constructor | the scoped effect `layer` is built from |
| `Position` | schema + type | `runId` plus a `Frame`; an address, never a snapshot |
| `Projection`, `ForkOptions`, `RewindOptions`, `ForkResult`, `RewindResult` | types | operation inputs and outputs |

| Operation | Notes |
| --- | --- |
| `inspect(position, projection)` | read-only fold of committed entries up to the frame; never invokes a flow handler or an action dispatcher, which is what separates it from an engine resume |
| `fork(position, options?)` | requires a terminal or inactive parent; the jj workspace name and path are derived from the position, and the lane is forgotten when the service is released. `options.workspaceRoot` only moves where it lands |
| `rewind(position, options?)` | the fenced, audited suffix-removal protocol. The ownership claim and audit id are minted inside; `options.detachedChildren` (`"block"` by default, or `"cancel"`) and `options.pageSize` are the only knobs |

Recovery is not an operation. Building `TimeTravel.layer` finishes or rolls
back every interrupted rewind audit before the service accepts work, so a
crashed rewind never needs a call the caller has to remember.

`Replay`, `Fork`, `Rewind`, `Retry`, `Recovery`, `Compensation`, and
`EffectHandlerRegistry` are internal machinery under
[src/internal/](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/internal);
the package blocks `@smthrs/time-travel/internal/*` at its `exports` map.

## EffectBoundary

[src/EffectBoundary.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/EffectBoundary.ts)

The producer side of the contract: engine code calls `EffectBoundary.guard` so
a later rewind has something to assess. It stays public for that reason.

| Export | Kind | Notes |
| --- | --- | --- |
| `guard`, `fromEntry`, `fromEntries`, `eventType` | functions + constant | records intent and outcome around an external effect |
| `EffectRecord`, `Description`, `EffectTier`, `EffectStatus` | shapes | `intended`, `succeeded`, `unknown` |

The engine is the producer: `@smthrs/engine-store` writes an `intended` record
before an irreversible action's body runs and a terminal record after it
settles, so an ordinary run leaves a rewind something to assess without the
application calling `guard` by hand.

## CompensationHandlers

[src/CompensationHandlers.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/CompensationHandlers.ts)

Compensation planning and tier-aware retry stay internal: `rewind` resolves them
itself. What a composition contributes is the handler, not the registry.

| Export | Kind | Notes |
| --- | --- | --- |
| `CompensationHandlers` | service | optional; the handlers a composition contributes |
| `layer(handlers)`, `layerNoop` | layers | `TimeTravel.layer` reads the service when present |
| `Handler` | shape | `kind` (the action name the engine journaled), `tier`, `residue`, `revert`, optional `assess`/`rollback` |

:::warning
With no handlers provided, a crossed record that is not sealed classifies as
`blocking` and the rewind fails with `irreversible`. That is the safe default.
:::

## TimeTravelError

[src/TimeTravelError.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/TimeTravelError.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `TimeTravelError` | class | carries a `TimeTravelErrorCode` |
| `TimeTravelErrorCode` | const + type | code literals |
| `error` | constructor | |

## Integration boundary

The protocols here are Implemented and tested against real stores, including against a journal an ordinary engine run wrote (`test/EngineIntegration.test.ts`). `EngineStore` populates them: it stamps `meta.lineageId` on every record it writes, journals a tier-2 anchor per attempt, and writes the effect-boundary records around an irreversible dispatch and a child spawn. Anchors reach `flows_time_travel_snapshots` through a projection of those journal records. The engine never writes this package's tables, which is what keeps the dependency arrow one-way. `SqlTimeTravelStore.createFork` derives the child's state at the frame and copies only the attempts the frame's prefix can explain.

:::warning[One gap remains]
A fork's workspace is created but not pinned to the frame's jj pointer, because `Jj` cannot provision a workspace at a revision. The fork discloses that as a warning rather than restoring the parent's tree (`.smithers/tickets/fork-workspace-revision.md`).
:::
