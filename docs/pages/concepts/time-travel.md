---
description: "Inspect, fork, and rewind over recorded history, and what of it the release candidate actually ships."
---

# Time travel

This page explains the inspect, fork, and rewind operations of the one
`TimeTravel` service in `@smthrs/time-travel`, and the snapshot, compensation,
and recovery machinery behind them. It also says what a composition still has
to wire by hand, and what of the surface the release candidate ships.

The surface sections below are generated from the package that owns them; edit
`packages/time-travel/docs/concepts.md`, never this file's generated region.

## Frames and snapshots

A `Frame` identifies a durable point by lineage and journal sequence:

```ts
import { Engine } from "@smthrs/flows"
import { Frame } from "@smthrs/time-travel"

const frame: Frame.Frame = {
  lineageId: Engine.FlowEngine.Lineage.root("build-42"),
  seq: 17
}
```

The lineage half of that address is minted, never spelled. `FlowEngine.Lineage`
is the one constructor for it, the engine stamps its result on every record a
run writes, and the encoding is versioned: a hand-written `<runId>/root` names
no record, and every operation refuses it as `not_found`. Reading
`meta.lineageId` off any entry the run committed is the other route, and the one
a viewer takes when it holds records rather than a run id.

A `Position` pairs that frame with the run it addresses: `{ runId, frame }` , 
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

`fork` requires a terminal or inactive parent run, creates a store-level fork, and asks `Jj` to add an isolated workspace pinned at the frame's recorded jj pointer. The workspace name and path are derived from the child run id the fork mints rather than supplied, so a frame forked twice gets two lanes, and the lane is forgotten when the service is released. A frame with no recorded pointer still lands at the lane default, and the fork discloses that as a warning rather than restoring the parent's tree.

The SQL store copies the parent's versioned engine state without terminal
result or cancellation fields and clones its attempt rows. The fork can
therefore be claimed and driven after engine layers restart. The existing
`flows_time_travel_edges` row remains the lineage source of truth.

A fork's state is the state at the frame. `SqlTimeTravelStore.createFork`
folds it from the run-decision records in the journal prefix and copies only
the attempts that prefix can explain, rather than copying the parent's current
row. The parent's current state is used only as a compatibility fallback, when
an older journal carries no frame-derived state. What remains planned
integration is the automatic creation of frame-addressed snapshots by ordinary
execution; the fold does not need them.

A cloned attempt row is addressed by its sealed cache key, and a cache key
computed under an undeclared `Action.CurrentCacheEnvironment` is scoped to
the execution that produced it (see [step keys](/concepts/step-keys)). A fork
therefore replays its parent's sealed attempts only when the composition
declares its environment through `Action.layerCacheEnvironment`. Without a
declaration the fork re-executes those actions rather than reusing rows it
cannot prove were produced under the same layers and capabilities. The
declaration is complete only when `Kernel.make` also receives
`options.cacheEnvironment`; a capability list alone deliberately leaves the
identity run-local.

## Effect boundaries and compensation

`EffectBoundary.guard` records intent and outcome around an external effect. Records classify the effect as `sealed`, `compensable`, or `irreversible`, and track `intended`, `succeeded`, or `unknown` status.

Behind the service, an effect-handler registry maps effect kinds to assessment and rollback handlers, classifies suffix records, invokes eligible handlers, and returns receipts. Unknown or irreversible effects can block a rewind. None of it is a caller parameter: `EffectBoundary` is the only half of that contract you touch, from the producer side.

{/* generated:time-travel-surface start */}

## Rewind protocol

`rewind`:

1. validates the position before anything durable exists, so a refused frame
   leaves no claim, no audit row, and no read page behind,
2. claims and activates an inactive pending or suspended run, and holds that
   lease with a heartbeat for as long as the protocol runs, so a co-located
   engine cannot steal the run out from under a slow compensation,
3. records an audit row and the rate-limit decision,
4. loads the journal entries after the target frame,
5. resolves descendants: an attached child still depending on the truncated
   history, and a detached child under the `block` policy, both refuse the
   rewind while they are live,
6. assesses and compensates external effects, persisting each receipt before
   the next irreversible step,
7. restores the Jujutsu workspace to the frame's pointer,
8. archives and truncates the suffix atomically, fenced on the ownership claim,
9. cancels the children the policy asked for, then records completion or a
   recoverable failure.

Step 8 is the commit point. Cancelling a child is terminal and has no inverse,
so it runs only after that commit: a rewind that fails earlier leaves every
child exactly as it was. The cancellations the operator asked for are written to
the audit detail before the commit, so a crash in the middle of them is finished
by the next recovery pass instead of being silently dropped. Terminal
descendants are disclosed as warnings, because their external effects cannot be
erased by deleting a parent suffix.

Step 9 is why recovery is not an operation: building `TimeTravel.layer` finishes
or rolls back any rewind a crash interrupted, before the service accepts new
work, except one whose run a live process still holds. That one is left exactly
as the crash left it, still pending and still recoverable, so a rewind a living
process still owns is never stolen. `TimeTravel.layerWith({ isAlive })` decides
what counts as live; the default is the lease check the engine's run driver
already applies to those rows.

## Current integration boundary

The time-travel package is implemented and tested as a protocol library,
including against a journal an ordinary engine run wrote. `EngineStore`
populates the evidence it reads: it stamps `meta.lineageId` on every record,
journals a tier-2 anchor per attempt, and writes the effect-boundary records
around an irreversible dispatch and a child spawn. What a composition still
supplies by hand is the store itself, the migration that creates its tables, and
any `CompensationHandlers` its adapters own.

## What 1.0.0-rc.0 ships

Time travel is a library API in this release, and only a library API.

| Surface                                          | 1.0.0-rc.0                                                                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TimeTravel.replay`, `inspect`, `fork`, `rewind` | available from `@smthrs/time-travel`. `replay` is the fold verb with its read knobs; `inspect` is the same fold under the service defaults                     |
| CLI verbs                                        | none. The Smithers 0.x time-travel verbs exit 1 with a migration message; [migrating from 0.x](/migration/1.0#removed-commands) lists them                     |
| MCP tools                                        | none. `replay_run`, `fork_run`, `rewind_run`, `restore_checkpoint`, `list_snapshots`, `get_timeline`, and `time_travel` answer with the `unsupported` envelope |
| Composition                                      | not composed into `NodeControl`, and the CLI does not install migration block 5000                                                                             |

A program that wants time travel provides `TimeTravelStore` and calls the
service itself. Nothing in the command line reaches it.

{/* generated:time-travel-surface end */}

The word "checkpoint" means two different things in this release, and neither
is a worktree lane. On the journal it is the durable state that replays a run
from an offset, described in
[checkpoints and compaction](/compaction). Inside an agent cell it is
`ctx.checkpoint()`, a pinned git tree taken by `@smthrs/std` `Checkpoints`.
There is no `Checkpoint` host capability and no lane lifecycle; see
[known limitations](/release/known-limitations).

See [Determinism and replay](/concepts/determinism-and-replay), [Subflows](/concepts/subflows), and the [`@smthrs/time-travel` reference](/api/time-travel).
