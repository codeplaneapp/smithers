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
`Replay`, `Fork`, `Rewind`, `Retry`, `Recovery`, `Compensation`,
`SnapshotProjector`, and `EffectHandlerRegistry` are machinery a caller never
names.

## Operations

`TimeTravel` is one injectable service with four operations, each addressed by
a `Position`: a run id plus a `Frame`.

| Operation                                | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `replay(position, projection, options?)` | folds the committed journal prefix up to the frame through a pure projection. It has no dispatcher, so a replay can never re-execute a model call or a child flow, and that is what separates it from an engine resume. The fold streams and stops reading at the frame. `options.pageSize` is a throughput knob; `options.maxHistoryEntries` caps the entries the fold reads for this call.                                                                                                                 |
| `inspect(position, projection)`          | the same fold as `replay`, under the service defaults. It exists for the caller that never tunes a read.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `fork(position, options?)`               | mints and reserves a child run id, provisions the child's jj workspace pinned at the frame's recorded pointer, then copies the journal prefix, the frame's anchors, and only the attempts that prefix can explain, and records the lineage edge. The parent is never mutated, and the fork refuses `live_parent` while the parent or any ancestor is live. `options.workspaceRoot` only moves which lane the derived workspace name lands in; `options.maxHistoryEntries` caps the suffix the fork assesses. |
| `rewind(position, options?)`             | the fenced, audited suffix-removal protocol. The ownership claim and the audit id are minted inside. `options.detachedChildren` (`"block"` by default, or `"cancel"`), `options.pageSize`, and `options.maxHistoryEntries` are the only knobs.                                                                                                                                                                                                                                                               |

The workspace a fork lands in is named after the child run id the fork mints,
never supplied: `smithers-fork-` plus the sanitized id capped at 64 characters
plus a short digest of the raw id. A frame forked twice therefore gets two
lanes, and the lane is forgotten when the service scope is released.

The mint is a durable reservation. A process that dies after provisioning the
lane and before the store commits the fork leaves a registered lane and a
reservation behind; the next build of `TimeTravel.layer` forgets the lane of
every reservation older than five minutes whose fork never committed, and the
reserved ordinal is never handed out again, so a retry lands under a fresh
lane name rather than asking jj for the one the leftover on disk still holds.

### Rewind order of operations

1. validate the position, before anything durable exists;
2. claim and activate the run, then hold the ownership lease with a heartbeat
   for as long as the protocol runs;
3. write the audit row and the rate-limit decision;
4. read the suffix after the frame and assess every effect boundary in it;
5. resolve descendants: a live child refuses the rewind under `"block"`;
6. compensate tier-3 effects, persisting the accumulated receipts after each handler;
7. restore the jj workspace to the frame's pointer;
8. persist the cancellation plan and claim every child it names;
9. archive and truncate the suffix atomically, fenced on the parent owner and
   every non-terminal attached child's exact owner.

Step 9 is the recovery commit point. Cancelling a child under
`detachedChildren: "cancel"` happens **after** it, because cancellation is
terminal and has no inverse. Pre-commit child claims are reversible and are
released when the archive fails: an originally suspended child returns to that
status, while a child claimed from pending or dead-running is safely parked
suspended because that is the run store's ownership-clearing reversible state.
The planned cancellations are written to the audit detail before any archive
mutation, so a crash between the commit and the last cancellation is finished
by the next recovery pass rather than silently dropped.

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

| Code                  | Raised by              | Means                                                                                                                                                                                         |
| --------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `busy`                | `rewind`, recovery     | another owner holds the run, or this operation lost its claim before it could finish. Retryable.                                                                                              |
| `live_parent`         | `fork`                 | the parent run, or an ancestor of it, is running, claimed, or owned, so it has no settled prefix to copy.                                                                                     |
| `live_child`          | `rewind`               | a descendant the truncation would cut history out from under is still executing, and the policy is `"block"`.                                                                                 |
| `not_found`           | all verbs              | the run, the frame, or the audit does not address anything: a coordinate past the journal tail, a lineage this run is not on, or a run row that is gone.                                      |
| `invalid`             | all verbs              | a caller-supplied option is malformed, or a durable payload does not decode. Refused before the operation touches anything.                                                                   |
| `already_crossed`     | `EffectBoundary.guard` | the effect already recorded a durable `intended` boundary, so executing it a second time was refused.                                                                                         |
| `rate_limited`        | `rewind`               | the supplied rate limiter rejected the attempt. The audit row records the decision.                                                                                                           |
| `compensation_failed` | `rewind`, recovery     | a rollback handler or the workspace restore failed, so the rewind stopped rather than leave the world half reverted.                                                                          |
| `irreversible`        | `rewind`               | an effect in the truncated range cannot be undone at all: no handler, or a sealed result whose cache entry is gone.                                                                           |
| `fence_lost`          | `rewind`               | the caller's ownership of the run was superseded before a mutation committed, so the mutation was refused rather than written behind the live owner.                                          |
| `limit_exceeded`      | all verbs              | the operation would read more journal entries than `maxHistoryEntries` allows: the prefix a replay folds, or the suffix a fork or rewind assesses. A rewind refuses before it claims the run. |
| `unknown`             | all verbs              | the store, the journal, or an unmapped host failure. The original cause is attached.                                                                                                          |

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
- Every read is capped by `maxHistoryEntries`. The default is 100,000 entries
  (`TimeTravel.defaultMaxHistoryEntries`); `TimeTravel.layerWith({ maxHistoryEntries })`
  sets the service default and each verb's options override it per call, and a
  value that is not a positive integer is refused `invalid`. A replay streams
  its fold and stops at the frame, so it retains nothing below it; a fork or
  rewind retains only the effect-boundary records of the suffix it assesses.
  Validation still scans a run's journal to its tail to find the frame, without
  retaining it.
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

A handler is held to what the evidence recorded. An effect that recorded a
`compensation` descriptor resolves only to the handler declaring the same
one, so an adapter swapped in after a restart never compensates evidence
another implementation left behind; an effect that recorded none resolves by
`kind`. A handler with `requiresIdempotencyKey` blocks and never reverts an
effect that recorded no key, a custom `assess` result is decoded against
`Assessment` and assesses `blocking` when it does not decode, and a rollback
refuses a receipt whose tier or descriptor the handler does not match.
