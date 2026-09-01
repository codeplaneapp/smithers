```ts
import { Engine } from "@smthrs/flows"
import { TimeTravel } from "@smthrs/time-travel"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const timeTravel = yield* TimeTravel
  const lineageId = Engine.FlowEngine.Lineage.root("build-42")
  const position = { runId: "build-42", frame: { lineageId, seq: 17 } }
  return yield* timeTravel.inspect(position, { initial: 0, reduce: (state) => state + 1 })
})
```

## Entry point

| Import                                   | Source                                                                                                                       | Platform                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `@smthrs/time-travel`                    | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/time-travel/src/index.ts)                           | the barrel is a browser-contract entry point and bundles without a `node:` built-in |
| `@smthrs/time-travel/SqlTimeTravelStore` | [src/SqlTimeTravelStore.ts](https://github.com/smithersai/smithers/blob/main/packages/time-travel/src/SqlTimeTravelStore.ts) | SQLite dialect only, on Node.js 22.19 or newer                                      |

Every module under `src/` is published at `@smthrs/time-travel/<Module>` by the
package `exports` map. `@smthrs/time-travel/internal/*` is mapped to `null`:
`Replay`, `Fork`, `Rewind`, `Recovery`, `Compensation`, `SnapshotProjector`, and
`EffectHandlerRegistry` are machinery a caller never names.

## Operations

`TimeTravel` is one injectable service with three operations, each addressed by
a `Position`: a run id plus a `Frame`.

| Operation                       | What it does                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect(position, projection)` | folds the committed journal prefix up to the frame through a pure projection. It has no dispatcher, so a replay can never re-execute a model call or a child flow, and that is what separates it from an engine resume. `inspect` is the replay entry point; there is no separate `replay` operation.                                       |
| `fork(position, options?)`      | mints a child run, copies the journal prefix, the frame's anchors, and only the attempts that prefix can explain, records the lineage edge, and provisions the child's jj workspace pinned at the frame's recorded pointer. The parent is never mutated. `options.workspaceRoot` only moves which lane the derived workspace name lands in. |
| `rewind(position, options?)`    | the fenced, audited suffix-removal protocol. The ownership claim and the audit id are minted inside. `options.detachedChildren` (`"block"` by default, or `"cancel"`) and `options.pageSize` are the only knobs.                                                                                                                            |

The workspace a fork lands in is named after the child run id the fork mints,
never supplied: `smithers-fork-` plus the sanitized id capped at 64 characters
plus a short digest of the raw id. A frame forked twice therefore gets two
lanes, and the lane is forgotten when the service scope is released.

### Rewind order of operations

1. validate the position, before anything durable exists;
2. claim and activate the run, then hold the ownership lease with a heartbeat
   for as long as the protocol runs;
3. write the audit row and the rate-limit decision;
4. read the suffix after the frame and assess every effect boundary in it;
5. resolve descendants: a live child refuses the rewind under `"block"`;
6. compensate tier-3 effects and persist their receipts;
7. restore the jj workspace to the frame's pointer;
8. archive and truncate the suffix atomically, fenced on the ownership claim.

Step 8 is the recovery commit point. Cancelling a child under
`detachedChildren: "cancel"` happens **after** it, because cancellation is
terminal and has no inverse: a rewind that fails before the commit leaves every
child exactly as it was. The planned cancellations are written to the audit
detail before the commit, so a crash between the commit and the last
cancellation is finished by the next recovery pass rather than silently dropped.

## Recovery

Recovery is not an operation. Building `TimeTravel.layer` finishes or rolls back
every interrupted rewind audit before the service accepts work, so a crashed
rewind never needs a call the caller has to remember.

The one audit it cannot resolve is one whose run a live process still holds.
That one is declined: the audit keeps its `in_progress` status, stays in
`pendingAudits`, and nothing is written, so a later build finishes it. Recording
it `failed` would close it terminally and drop it from `pendingAudits` forever.

`Options.isAlive` is an [`Ownership.LivenessCheck`](/api/run-store) and decides
what "still live" means. It defaults to `Ownership.leaseLiveness()`, the same
check the engine's run driver applies to those rows: an owner is alive while its
persisted heartbeat is younger than `Ownership.heartbeatStaleAfter`. A supplied
check can only refuse a takeover, never widen one, because the evidence recovery
hands `RunStore.steal` is always `lease-expired` and `steal` re-verifies that
claim inside the same write.

```ts
import * as Ownership from "@smthrs/run-store/Ownership"
import { TimeTravel } from "@smthrs/time-travel"

const layer = TimeTravel.layerWith({ isAlive: Ownership.leaseLiveness() })
```

## Failure behaviour

Every operation fails as a `TimeTravelError` discriminated by a closed `code`,
so a caller's branch stays exhaustive. This table is checked against
`TimeTravelErrorCode` by the page generator: a code that exists in one and not
the other fails the build.

| Code                  | Raised by              | Means                                                                                                                                                    |
| --------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `busy`                | `rewind`, recovery     | another owner holds the run, or this operation lost its claim before it could finish. Retryable.                                                         |
| `live_parent`         | `fork`                 | the parent run, or an ancestor of it, is running, claimed, or owned, so it has no settled prefix to copy.                                                |
| `live_child`          | `rewind`               | a descendant the truncation would cut history out from under is still executing, and the policy is `"block"`.                                            |
| `not_found`           | all three              | the run, the frame, or the audit does not address anything: a coordinate past the journal tail, a lineage this run is not on, or a run row that is gone. |
| `invalid`             | all three              | a caller-supplied option is malformed, or a durable payload does not decode. Refused before the operation touches anything.                              |
| `already_crossed`     | `EffectBoundary.guard` | the effect already recorded a durable `intended` boundary, so executing it a second time was refused.                                                    |
| `rate_limited`        | `rewind`               | the supplied rate limiter rejected the attempt. The audit row records the decision.                                                                      |
| `compensation_failed` | `rewind`, recovery     | a rollback handler or the workspace restore failed, so the rewind stopped rather than leave the world half reverted.                                     |
| `irreversible`        | `rewind`               | an effect in the truncated range cannot be undone at all: no handler, or a sealed result whose cache entry is gone.                                      |
| `fence_lost`          | `rewind`               | the caller's ownership of the run was superseded before a mutation committed, so the mutation was refused rather than written behind the live owner.     |
| `unknown`             | all three              | the store, the journal, or an unmapped host failure. The original cause is attached.                                                                     |

An error's `cause` is encoded with the error, so the package never attaches a
whole effect record or a whole parse issue to one: a blocking assessment travels
as its identity and classification, never as the effect's `input` or `output`.

## Limits

- The durable store is SQLite dialect only. Its DDL uses `typeof()` and
  `json_valid` CHECK constraints and its reads use `json_extract` with `$`
  paths, so any SQLite-speaking `SqlClient` runs it and nothing else does.
  PostgreSQL and PGlite are unsupported.
- Journal reads page at 100 entries by default. `pageSize` is a throughput knob
  and never changes a derived answer.
- A rewind materializes the suffix after the frame, and a fork the suffix it
  carries past, in memory. Both refuse a suffix past a fixed bound rather than
  exhausting the process while a run's ownership is held.
- `Projection.reduce` receives store entries by reference. Treat them as
  read-only: mutating one rewrites the evidence the fold is reading.
- The memory store is a behavioural peer of the SQL store for the answers both
  give, not a durable one. It holds everything in JavaScript objects.

## Composition

`TimeTravel.layer` requires `TimeTravelStore`, `Journal`, `RunStore`,
`CacheStore`, and `Jj`, and nothing else. Time travel is a library API in
1.0.0-rc.0: it is not composed into `NodeControl`, there is no CLI verb, and the
matching MCP tools answer with the `unsupported` envelope.

The engine is the producer of everything the service reads.
`@smthrs/engine-store` stamps `meta.lineageId` on every record it writes,
journals a tier-2 anchor per attempt, and writes effect-boundary records around
an irreversible dispatch and around a child spawn. Anchors reach
`flows_time_travel_snapshots` through a projection of those journal records, so
the engine never writes this package's tables and the dependency arrow stays one
way.

`SqlTimeTravelStore.migrate` creates `flows_time_travel_snapshots`,
`flows_time_travel_edges`, `flows_time_travel_audits`,
`flows_time_travel_receipts`, and `flows_time_travel_archive`, and indexes
`meta_json.lineageId` on the journal's own `flows_journal_events` so a
lineage-filtered read is not a full run scan. `Migrations` publishes the same
DDL as a rung on the shared ladder at id block `5000`, for a composition that
owns migration itself.

With no `CompensationHandlers` provided, a crossed record that is not sealed
resolves to no handler, classifies as `blocking`, and the rewind fails
`irreversible`. That is the safe default.
