---
description: "Every durable shape in Smithers: where it lives, who writes it, who reads it, and which invariants hold."
---

# Data structures

Everything durable in Smithers is one of a small number of shapes. This page names each shape, says where it lives, who writes it, who reads it, and which invariants hold. Read it before the per-package API pages: those tables list exports, this one explains what the exports move around.

## Where the shapes live

| Shape                | Table                         | Migration                            | Package                |
| -------------------- | ----------------------------- | ------------------------------------ | ---------------------- |
| Journal entry        | `flows_journal_events`        | `0001_initial`                       | `@smthrs/journal`      |
| Journal checkpoint   | `flows_journal_checkpoints`   | `0002_checkpoints`                   | `@smthrs/journal`      |
| Run row              | `flows_runs`                  | `0001_initial`, `0002_lineage`       | `@smthrs/run-store`    |
| Attempt row          | `flows_attempts`              | `0001_initial`                       | `@smthrs/run-store`    |
| Cache row            | `flows_step_cache`            | `0001_initial`                       | `@smthrs/step-cache`   |
| Deferred completion  | `flows_deferred_completions`  | `0001_initial`                       | `@smthrs/engine-store` |
| Clock deadline       | `flows_clock_deadlines`       | `0001_initial`                       | `@smthrs/engine-store` |
| Run-parent edge      | `flows_run_parents`           | created by `DurableEngineState.make` | `@smthrs/engine-store` |
| Plan row             | `flows_plans`                 | `0001_initial`                       | `@smthrs/plan`         |
| Plan node            | `flows_plan_nodes`            | `0001_initial`                       | `@smthrs/plan`         |
| Plan edge            | `flows_plan_edges`            | `0001_initial`                       | `@smthrs/plan`         |
| Frame snapshot       | `flows_time_travel_snapshots` | `SqlTimeTravelStore.migrate`         | `@smthrs/time-travel`  |
| Lineage edge         | `flows_time_travel_edges`     | `SqlTimeTravelStore.migrate`         | `@smthrs/time-travel`  |
| Rewind audit         | `flows_time_travel_audits`    | `SqlTimeTravelStore.migrate`         | `@smthrs/time-travel`  |
| Compensation receipt | `flows_time_travel_receipts`  | `SqlTimeTravelStore.migrate`         | `@smthrs/time-travel`  |
| Archived entry       | `flows_time_travel_archive`   | `SqlTimeTravelStore.migrate`         | `@smthrs/time-travel`  |

Two shapes are in-memory only: the action step keys the engine derives, which are recomputed on every replay, and sync frames, which exist on the wire. A compiled plan's node keys are different: they are computed once at plan time and persisted in `flows_plan_nodes`.

## Journal entries

A submitted event is a `JournalEvent.Input`. A committed one is a `JournalEvent.Entry`.

```ts
new JournalEvent.Input({
  runId: "run-42" as JournalEvent.RunId,
  sourceId: "worker-a" as JournalEvent.SourceId,
  sourceSeq: 0 as JournalEvent.SourceSeq,
  eventType: "example.completed",
  payload: { value: 42 },
  meta: { lineageId: "root" }
})
```

| Field         | Column          | Meaning                                                            |
| ------------- | --------------- | ------------------------------------------------------------------ |
| `runId`       | `run_id`        | which run this entry orders under                                  |
| `seq`         | `seq`           | canonical order within one run, assigned at commit                 |
| `eventId`     | `event_id`      | `makeEventId(runId, sourceId, sourceSeq)`, unique across the table |
| `sourceId`    | `source_id`     | producer identity                                                  |
| `sourceSeq`   | `source_seq`    | producer-local order, unique per `(runId, sourceId)`               |
| `emittedAtMs` | `emitted_at_ms` | writer clock                                                       |
| `eventType`   | `event_type`    | open string, indexed                                               |
| `payload`     | `payload_json`  | application-defined                                                |
| `meta`        | `meta_json`     | application-defined                                                |

Invariants:

- `(run_id, seq)` is the primary key, and `(run_id, source_id, source_seq)` is unique. An exact retry of one producer identity collapses onto the original `seq` and returns `Duplicate`.
- Reusing a producer identity with different content fails with `idempotency_conflict`.
- Sequence numbers may have holes. A rejected or dropped admission still consumes its number, so consumers treat `seq` as an ordered cursor rather than a contiguous counter.
- There is no global order across runs.
- `payload` and `meta` pass through the single `Redaction` chokepoint on encode. Executable state does not: run state, attempt checkpoints, outcomes, errors, and cache results round-trip verbatim, because rewriting them would resume a flow with the wrong data.

### The two channels

| Channel | Entry point   | Durability                                                               | Use it for                                             |
| ------- | ------------- | ------------------------------------------------------------------------ | ------------------------------------------------------ |
| durable | `emitDurable` | allocates and commits inside the write transaction; returns after COMMIT | lifecycle evidence, anything a recovery argument cites |
| lossy   | `emitLossy`   | bounded non-blocking queue; returns before COMMIT                        | telemetry where a drop is acceptable                   |

:::warning
An `Accepted` receipt from the lossy queue means the event entered the writer queue. A crash can still lose it.
:::

Overflow behavior is explicit:

| Policy        | Full queue                                                       |
| ------------- | ---------------------------------------------------------------- |
| `reject`      | fail with `queue_overflow`                                       |
| `drop-newest` | return `Dropped`                                                 |
| `drop-oldest` | evict one queued event, return `Accepted` with eviction evidence |

### Writers and readers

The writer is one scoped fiber inside `SqlJournal.layer`, persisting batches through `DurableWriter.write`. Published entries reach the general `changes` subscription and the per-run wake channels that `stream` follows, and publication is deferred until the outermost transaction commits.

Readers: `Journal.entries` pages history, `Journal.stream` replays then follows, `Journal.project` folds a stream through a deterministic reducer with no separate durable state, `@smthrs/sync` replicates entries to followers, and `@smthrs/time-travel` reads suffixes and archives them.

### Event types the engine writes

| Event type                                                                                      | Written by                         |
| ----------------------------------------------------------------------------------------------- | ---------------------------------- |
| `flows.engine.run-decision`                                                                     | run-row transitions                |
| `flows.engine.attempt-started`, `flows.engine.attempt-finished`                                 | attempt lifecycle                  |
| `flows.engine.cache-provenance`, `flows.engine.cache-conflict`, `flows.engine.cache-corruption` | cache admission and its failures   |
| `flows.engine.snapshot-identified`                                                              | compensable pre-image capture      |
| `flows.engine.hard-violation`, `flows.engine.expected-set-deviation`                            | step-boundary settle               |
| `flows.engine.deferred-completed`, `flows.engine.clock-scheduled`                               | durable primitives                 |
| `flows.engine.interrupted`                                                                      | cancellation and interrupt release |
| `flows.kernel.grant.once.v1`, `.run.v1`, `.remembered.v1`, `.denied.v1`, `.envelope.v1`         | `JournalGrantStore`                |
| `flows.time-travel.effect-boundary`                                                             | `EffectBoundary.guard`             |

## Run rows

`RunStore.RunRow` is control state, written directly by compare-and-swap. It is not derived from the journal.

| Column                                                         | Meaning                                                               |
| -------------------------------------------------------------- | --------------------------------------------------------------------- |
| `run_id`                                                       | primary key, the execution id                                         |
| `status`                                                       | `pending`, `running`, `suspended`, `completed`, `failed`, `cancelled` |
| `created_at_ms`, `started_at_ms`, `finished_at_ms`             | lifecycle stamps                                                      |
| `owner_host_id`, `owner_pid`, `owner_nonce`, `heartbeat_at_ms` | the ownership fence                                                   |
| `claim_host_id`, `claim_pid`, `claim_nonce`, `claimed_at_ms`   | the claim generation                                                  |
| `state_json`                                                   | encoded payload and, once terminal, the encoded `Flow.Result`         |
| `parent_run_id`, `cancel_requested_at_ms`                      | parentage and cancellation guards                                     |
| `lineage_id`, `round_ordinal`                                  | the trampoline pair added by `0002_lineage`, unique together          |
| `waiting_reason`, `waiting_wake_at_ms`, `waiting_token`        | parked-run query and wake data                                        |

`lineage_id` and `round_ordinal` are `NULL` on an ordinary run, which reads as round 0 of a lineage of one. `waiting_*` is created by this migration but read and written only by `@smthrs/engine-store`; `RunStore.RunRow` does not model those three columns.

Table `CHECK` constraints enforce the first two invariants below. The third is a convention `RunStore` upholds, not a constraint:

- Enforced: a `running` row has all four owner fields set. Any other status has all four `NULL`. Moving to `suspended` or a terminal status therefore clears ownership atomically with the transition.
- Enforced: the four claim fields are all set or all `NULL`, and `status` is one of the six names above.
- Convention: the lifecycle is `pending → running → completed | failed | suspended | cancelled`, and `suspended → running` on a wake. Nothing in the schema enforces the transition graph. `transitionOwned` writes any `RunStatus` its owner fence admits, so a writer that bypasses `RunStore` can land a shape no reader expects.

Ownership constants live in `Ownership`: a 1 second heartbeat interval, a 19 second write tolerance, and a 30 second stale threshold. The write tolerance is eleven ticks shorter than the steal cutoff, so an owner whose heartbeat writes fail is always interrupted before a peer may take over.

:::warning
Takeover also requires `LivenessEvidence`. Elapsed time alone does not prove an owner is dead.
:::

### Waiting rows

A parked run carries a reason. `DurableEngineState.park` writes it, `wake` clears it, and `waitingRuns` is what a sweeper enumerates.

| Reason                                      | Source                        |
| ------------------------------------------- | ----------------------------- |
| declared, for example `approval` or `quota` | `FlowRuntime.annotateWaiting` |
| `timer`                                     | the earliest clock deadline   |
| `event`                                     | anything else                 |

An annotation is consumed once its awaited deferred resolves, so a later suspension parks under its own reason rather than a replayed one.

## Attempt rows

An attempt is addressed by `(runId, stepKeyDigest, attempt)`, where `stepKeyDigest` is the result of decoding the step key through `Sha256`.

| Column                                               | Meaning                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `state`                                              | the configurable in-progress vocabulary, then a terminal state |
| `started_at_ms`, `finished_at_ms`, `heartbeat_at_ms` | lifecycle stamps                                               |
| `checkpoint_json`                                    | up to 1 MiB; omitting one preserves the previous checkpoint    |
| `error_json`, `outcome_json`                         | the encoded exit                                               |
| `meta_json`                                          | opaque, and where the `FileBoundary` is carried                |

Invariants: mutations are fenced by the current run owner, and the first fenced terminal transition wins. A later `finish` observes `StateChanged`. A persisted `failed` row replays by rethrowing the persisted domain failure, so a non-retryable failure matches on resume without another dispatch.

## Cache rows

`flows_step_cache` maps a digest to a result. Writes are first-writer-wins.

| Column                                  | Meaning                                                  |
| --------------------------------------- | -------------------------------------------------------- |
| `key_digest`                            | primary key, the `Sha256` transformation of the step key |
| `result_json`                           | the encoded action success                               |
| `meta_json`                             | opaque metadata                                          |
| `created_at_ms`                         | creation stamp                                           |
| `recorded_run_id`, `recorded_event_seq` | journal provenance                                       |

| Put outcome    | When                                 |
| -------------- | ------------------------------------ |
| `Inserted`     | no row existed                       |
| `ExistingSame` | a row existed with equal content     |
| `Conflict`     | a row existed with different content |

A `Conflict` is journalled as `flows.engine.cache-conflict` and handed to `Inconsistency`. The unwired core default is strict: journal, then fail the run.

## Step keys

{/* generated:keys-contract start */}

[`@smthrs/keys`](/api/keys) owns one current derivation and the exact stored
representations this release can validate. `deriveKey` maps canonical key
material to `key1_` plus a SHA-256 digest. `KeyV1` and `StoredKey` validate that
wire value unchanged; they never hash it. The compatibility `Key` schema still
derives, so key-shaped text decoded through `Key` becomes a different key.
Unknown versions are rejected until their complete format is implemented.
Canonical serialization belongs to `@smthrs/canonical`, hashing belongs to
`@smthrs/crypto`, and domain-specific material belongs to each caller.

{/* generated:keys-contract end */}

### Canonical serialization

{/* generated:canonical-serialization start */}

Decoding through `Canonical` produces RFC 8785 JSON. The wrapped `canonicalize` library sorts object keys, preserves array order, uses deterministic number formatting, and rejects inputs that cannot produce valid canonical JSON. The wrapper additionally rejects lone Unicode surrogates.

{/* generated:canonical-serialization end */}

### Cache keys

```ts
yield * Schema.decodeUnknownEffect(Key)({ operation: "compile", version: 3 })
```

A sealed action key changes when its caller identity, complete cache environment, or filesystem boundary changes. The engine owns that combined input; `@smthrs/keys` only hashes it.

A string `idempotencyKey` folds in the action name and declared schemas. An object identity is caller-owned and rename-stable.

If no complete environment is declared, the key includes the current execution ID and cannot be reused across runs.

### Invocation keys

```ts
{ runId: "run-42", parentScope: "checkout", ordinal: 3, tier: "compensable" }
```

The engine hashes this private shape through `Key`. Ordinals are allocated per declaration identity, meaning the action name refined by any declared key, and that scope is folded into the key as `parentScope`.

## Frames and time-travel shapes

```ts
const frame: Frame.Frame = { lineageId: Engine.FlowEngine.Lineage.root("build-42"), seq: 17 }
```

A frame names a durable point by lineage plus journal sequence. The lineage half
is minted by `FlowEngine.Lineage`, reached as `Engine.FlowEngine` from
`@smthrs/flows`, and the engine stamps it on every record a run writes. It is a
versioned encoding rather than a path, so a hand-written address names no
record. The stores hold:

| Shape        | Columns                                                                         | Notes                                           |
| ------------ | ------------------------------------------------------------------------------- | ----------------------------------------------- |
| Snapshot     | `run_id`, `lineage_id`, `seq`, `change_id`                                      | the jj change a frame maps to                   |
| Lineage edge | `parent_run_id`, `parent_seq`, `child_run_id` (unique), `kind`, `attached`      | `kind` is `child`, `fork`, or `continuation`    |
| Audit        | `id`, `run_id`, `lineage_id`, `seq`, `status`, `rate_limit_json`, `detail_json` | one rewind attempt                              |
| Receipt      | `id`, `audit_id`, `effect_id`, `receipt_json`                                   | one compensation outcome                        |
| Archive      | the full journal-entry columns plus `archived_at_ms`                            | the truncated suffix, moved rather than deleted |

Rewind archives and truncates the suffix in one transaction, so an interrupted rewind is recoverable at startup rather than leaving a half-erased history.

## Sync messages

Sync shapes are on the wire, never in a table.

| Shape                          | Contents                                           |
| ------------------------------ | -------------------------------------------------- |
| `Scope`                        | `Run` with a `runId`, or `Workspace`               |
| `RunCursor`                    | `runId` plus `afterSeq`                            |
| `WorkspaceCursor`              | an array of run cursors                            |
| `Resync`                       | `runId` plus the `checkpointSeq` a compacted run resumes from |
| `ReadRequest` / `ReadResponse` | scope, cursor, limit; entries plus the next cursor |
| `SubscribeRequest`             | scope, cursors, and a credit count                 |
| `EntriesFrame`                 | entries plus the next cursor                       |
| `HeartbeatFrame`               | emitted when no entries arrive                     |
| `ClosedFrame`                  | the single terminal frame                          |

Because journal sequences may have holes, `afterSeq` means entries after this number. Credit bounds the frames one subscription emits. There is no acknowledgement RPC, so a client that needs more opens another subscription from its last durable cursor. `Resync` is not a frame: it rides on `SyncError` as an optional field, set only on the `compacted` code, and it moves a cursor rather than delivering the state below the checkpoint.

:::warning
Persist a returned cursor only after applying the batch that came with it.
:::

## The atomicity rule that ties these together

A state transition and the lifecycle entry describing it commit in one write transaction, opened by `Journal.transact`. Every store above writes through the same `DurableWriter`, so their writes join that transaction as savepoints. Either both halves are durable or neither is. [Internal details](/internals) lists the exact pairs and what follows from them.
