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
| `@smthrs/time-travel` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/time-travel/src/index.ts) | any |

## Frame

[src/Frame.ts](https://github.com/smithersai/smithers/blob/main/packages/time-travel/src/Frame.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Frame` | schema + type | `lineageId` plus journal `seq` |
| `LineageEdge` | interface | parent, child, and kind |
| `LineageEdgeKind` | const + type | `child`, `fork`, `continuation` |

## TimeTravelStore

[src/TimeTravelStore.ts](https://github.com/smithersai/smithers/blob/main/packages/time-travel/src/TimeTravelStore.ts)

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
| `MemoryTimeTravelStore.make`, `layer`, `MemoryState`, `JournalRecord`, `Options` | [src/MemoryTimeTravelStore.ts](https://github.com/smithersai/smithers/blob/main/packages/time-travel/src/MemoryTimeTravelStore.ts) | deterministic tests |
| `SqlTimeTravelStore.migrate`, `make`, `layer` | [src/SqlTimeTravelStore.ts](https://github.com/smithersai/smithers/blob/main/packages/time-travel/src/SqlTimeTravelStore.ts) | creates its tables on build |
| `Migrations.set`, `sets`, `run`, `layer` | [src/Migrations.ts](https://github.com/smithersai/smithers/blob/main/packages/time-travel/src/Migrations.ts) | the same DDL as a rung on the shared ladder, at id block `5000` |

`SqlTimeTravelStore.migrate` creates `flows_time_travel_snapshots`, `flows_time_travel_edges`, `flows_time_travel_audits`, `flows_time_travel_receipts`, and `flows_time_travel_archive`, and indexes `meta_json.lineageId` on the journal's own `flows_journal_events` so a lineage-filtered read is not a full run scan.

## TimeTravel

[src/TimeTravel.ts](https://github.com/smithersai/smithers/blob/main/packages/time-travel/src/TimeTravel.ts)

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
| `fork(position, options?)` | requires a terminal or inactive parent; the jj workspace name and path are derived from the child run id the fork mints, so a frame forked twice gets two lanes, and the lane is forgotten when the service is released. `options.workspaceRoot` only moves where it lands |
| `rewind(position, options?)` | the fenced, audited suffix-removal protocol. The ownership claim and audit id are minted inside; `options.detachedChildren` (`"block"` by default, or `"cancel"`) and `options.pageSize` are the only knobs |

Recovery is not an operation. Building `TimeTravel.layer` finishes or rolls
back every interrupted rewind audit before the service accepts work, so a
crashed rewind never needs a call the caller has to remember.

`Replay`, `Fork`, `Rewind`, `Retry`, `Recovery`, `Compensation`, and
`EffectHandlerRegistry` are internal machinery under
[src/internal/](https://github.com/smithersai/smithers/blob/main/packages/time-travel/src/internal);
the package blocks `@smthrs/time-travel/internal/*` at its `exports` map.

## EffectBoundary

[src/EffectBoundary.ts](https://github.com/smithersai/smithers/blob/main/packages/time-travel/src/EffectBoundary.ts)

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

[src/CompensationHandlers.ts](https://github.com/smithersai/smithers/blob/main/packages/time-travel/src/CompensationHandlers.ts)

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

[src/TimeTravelError.ts](https://github.com/smithersai/smithers/blob/main/packages/time-travel/src/TimeTravelError.ts)

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

## API reference

This page is the public API reference for the `TimeTravel` service and the stores it reads through. The service is not part of every engine composition, but its evidence is: an ordinary `EngineStore` run stamps `meta.lineageId` on every record, journals a tier-2 anchor per attempt, and writes effect-boundary records, so a journal is inspectable, forkable, and rewindable without the application emitting anything by hand.

### Frames and stores

`Frame.Frame` is the schema for `{ lineageId, seq }`. `LineageEdgeKind` is `child`, `fork`, or `continuation`; `LineageEdge` relates a parent sequence to a child run. Store snapshots associate that frame with a run ID and Jujutsu change ID.

`TimeTravelStore.Service` stores and retrieves:

- snapshots at frames: `snapshotAt` reads the nearest anchor at or before a frame, `recordSnapshot` writes one (the snapshot projector is its only caller),
- run state and admitted attempts at a frame: `stateAt` and `attemptsAt` fold the journal's own decision and attempt records rather than reading the run row's current values,
- descendants and lineage edges,
- rewind audits and compensation receipts,
- fork records,
- atomic archive/truncation results.

`TimeTravelStore` exports `make`, `makeNoop`, and `layerNoop`. `MemoryTimeTravelStore.make/layer` provides observable memory state. `SqlTimeTravelStore.migrate`, `make`, and `layer` provide SQL persistence over `DurableWriter` and Effect's `SqlClient`.

### Operations

`TimeTravel` is one injectable service with three operations, each addressed by
a `Position`, a run ID plus a `Frame`:

| Operation | Main API |
| --- | --- |
| inspect | `inspect(position, projection)` folds committed journal entries |
| fork | `fork(position, options?)` creates a fork and its derived Jujutsu workspace |
| rewind | `rewind(position, options?)` runs the fenced audit/compensate/restore/archive protocol |

`TimeTravel.layer` requires `TimeTravelStore`, `Journal`, `RunStore`,
`CacheStore`, and `Jj`, and nothing else. Building it completes or rolls back
interrupted rewind audits, so recovery is never a call. `Replay`, `Fork`,
`Rewind`, `Retry`, `Recovery`, `Compensation`, and `EffectHandlerRegistry` are
internal machinery under `src/internal/`.

`ForkOptions` carries only `workspaceRoot`; the workspace name is
`smithers-fork-` followed by the child run id the fork mints, sanitized, capped
at 64 characters, and suffixed with a short digest of the raw id, so a frame
forked twice gets two lanes. `RewindOptions` carries `detachedChildren` and
`pageSize`; the owner and audit ID are minted internally. `RewindResult`
returns audit, archive, assessments, warnings, and cancelled children.

Cancelling a detached child under `detachedChildren: "cancel"` is terminal and happens *before* the archive commit point, so it is the one rewind mutation rollback cannot undo. Each cancellation is written to the audit detail as it happens, and a rewind that later rolls back keeps the full `cancelledChildren` list and names the surviving cancellations in `detail.failure`. A `rolled_back` audit therefore never understates what the attempt left behind.

Startup recovery uses archive evidence, not the engine-store replay classifier. An audit at `archive_committed` or `completed` is completed. Otherwise recovery requires the recorded suffix tail to be absent from the live journal and present in the archive. Missing or partial suffix evidence, or missing archive evidence, rolls back the compensation and restores the run's original state; it does not declare the rewind complete.

### External-effect records

`EffectBoundary.guard` records an external effect’s intended and terminal status using the journal. `fromEntry` and `fromEntries` decode those records. `eventType` is the stable journal event name.

The engine writes these records itself: an irreversible action dispatch is
wrapped in an `intended` record before the body runs and a `succeeded` or
`unknown` record after it settles, and a child spawn is journaled as one too.

Compensation planning stays internal: `rewind` resolves handlers, classifies
each record as `revertible`, `warning`, or `blocking`, and records the rollback
receipts on its audit itself. What is public is the *door*:
`CompensationHandlers.layer([...])` contributes handlers from the composition
that owns the adapter. It is optional; with none provided, a crossed record that
is not sealed resolves to no handler, classifies as `blocking`, and the rewind
fails with `irreversible`.

| Export | Kind | Notes |
| --- | --- | --- |
| `CompensationHandlers` | service | the handlers a composition contributes |
| `layer(handlers)`, `layerNoop` | layers | provide them; `layerNoop` is the default |
| `Handler` | shape | `kind`, `tier`, `residue`, `revert`, optional `assess`/`rollback` |

### Errors

`TimeTravelError` is the tagged failure type. `TimeTravelErrorCode` is `busy`, `live_parent`, `live_child`, `not_found`, `rate_limited`, `compensation_failed`, `irreversible`, or `unknown`. `error(code, message, cause?)` is the constructor helper.

### Fork

`SqlTimeTravelStore.createFork` creates a restartable engine row whose state is
the state **at** the frame: folded from the run-decision records, not copied
from the parent's current row: copies the selected journal prefix, copies only
the attempts that prefix can explain, and writes a `fork-created` marker on the
child naming `(parentRunId, forkJournalOffset)`. Lineage is recorded twice: in
`flows_time_travel_edges` for the attach/detach protocol, and in the child's
`flows_runs.parent_run_id` so ancestry is walkable with a recursive CTE and
survives edge archival. Child-spawn edges are not stored a third time; they are
derived from the parent journal's own spawn record, the only source that carries
a parent sequence. Trampoline continuation edges come from the same place: the
`handed-off` run decision the finishing round journals names `nextExecutionId`
at the sequence the round advanced, so `descendants` reports each later round as
a `continuation` edge, detached: a round owns its own claim and its own
journal, so rewinding past the handoff orphans it rather than requiring it to be
cancelled.

A fork never touches the parent: the boundary assessment still runs, but every
verdict is normalized into `Fork.warnings`. "this effect may execute again on
the child", and nothing is reverted, truncated, or restored. The child's lane is
added but **not** pinned to the frame's jj pointer: `Jj` acts on the one working
copy it is rooted at and cannot provision a workspace at a revision, so pinning
it would restore the parent's tree. The fork discloses the pointer as a warning
instead (`.smithers/tickets/fork-workspace-revision.md`).

See [Time travel](/concepts/time-travel), [Failure and retry](/concepts/failure-and-retry), and [Implementation status](/release/support-matrix).
