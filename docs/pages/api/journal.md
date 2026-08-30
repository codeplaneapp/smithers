---
description: "The logical write-ahead log: the event history, its projections and redaction, and the OwnerId fence."
---

# @smthrs/journal

The logical write-ahead log: the immutable event history, its projections and redaction, and the `OwnerId` fence its durable channel accepts. Run and attempt state live in [`@smthrs/run-store`](/api/run-store), sealed step results in [`@smthrs/step-cache`](/api/step-cache). The journal writes through the `@smthrs/database` contract, so the package root bundles for the browser.

```ts
import { Journal, JournalEvent, Migrations, SqlJournal } from "@smthrs/journal"
import * as Layer from "effect/Layer"

const layer = SqlJournal.layer({ capacity: 1024, overflow: "reject" }).pipe(
  Layer.provideMerge(Migrations.layer)
)
```

## Entry points

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/journal` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/journal/src/index.ts) | any |
| `@smthrs/journal/test/TestJournal` | [src/test/TestJournal.ts](https://github.com/smithersai/smithers/blob/main/packages/journal/src/test/TestJournal.ts) | Node |
| `@smthrs/journal/test/Notifying` | [src/test/Notifying.ts](https://github.com/smithersai/smithers/blob/main/packages/journal/src/test/Notifying.ts) | any |

## JournalEvent

[src/JournalEvent.ts](https://github.com/smithersai/smithers/blob/main/packages/journal/src/JournalEvent.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `RunId`, `Seq`, `SourceId`, `SourceSeq` | branded schema + type | the two sequence domains |
| `Input` | class | submitted event: `runId`, `sourceId`, `sourceSeq`, `eventType`, `payload`, `meta` |
| `Entry` | class | committed event: `Input` plus `seq`, `eventId`, `emittedAtMs` |
| `makeEventId` | function | deterministic id from `(runId, sourceId, sourceSeq)` |

## Journal

[src/Journal.ts](https://github.com/smithersai/smithers/blob/main/packages/journal/src/Journal.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Journal` | service tag | `@smthrs/journal/Journal` |
| `Service` | interface | the methods below |
| `make`, `makeNoop` | constructors | |
| `layerNoop` | layer | |
| `JournalError` | class | carries a `JournalErrorCode`; `checkpointSeq` names the resync point on the compaction-aware codes |
| `JournalErrorCode` | const + type | includes `queue_overflow`, `idempotency_conflict`, `journal_closed`, `compacted`, `reader_behind`, `checkpoint_invalid` |
| `OverflowPolicy` | type | `reject`, `drop-newest`, `drop-oldest` |
| `Accepted`, `Duplicate`, `Dropped` | interfaces | receipt variants |
| `EmitReceipt`, `DurableReceipt` | types | receipt unions |
| `StreamOptions`, `EntriesOptions`, `EntriesPage` | interfaces | read arguments and page shape |
| `Checkpoint` | class | replay state pinned to a committed sequence; `compactedAtMs` non-null once it is the floor |
| `CheckpointOptions`, `CompactOptions`, `Compacted` | interfaces | checkpoint and compaction arguments and receipt |

| Method | Returns | Behavior |
| --- | --- | --- |
| `emitLossy(input)` | `EmitReceipt` | bounded non-blocking queue; may return `Dropped` |
| `emitDurable(input, owner?)` | `DurableReceipt` | allocates and commits inside the write transaction |
| `transact(effect)` | `A` | runs a state projection and its `emitDurable` calls in one transaction |
| `stream(options)` | `Stream<Entry>` | durable history, then committed changes |
| `entries(options)` | `EntriesPage` | paged read |
| `changes` | `PubSub.Subscription<Entry>` | post-commit publication |
| `project(projection, options)` | `Stream<S>` | folds `stream` through a deterministic reducer |
| `flush` | `void` | barrier for the lossy queue |
| `checkpoint(options, owner?)` | `Checkpoint` | durably captures replay state at a committed sequence, in `transact`'s discipline |
| `latestCheckpoint(runId)` | `Option<Checkpoint>` | the resync point for a compacted run |
| `compact(options, owner?)` | `Compacted` | truncates strictly below a checkpoint, atomically with the floor advance |

:::warning
Reads below a run's compaction floor fail with `compacted`. See [Checkpoints and compaction](/compaction).
:::

## SqlJournal

[src/SqlJournal.ts](https://github.com/smithersai/smithers/blob/main/packages/journal/src/SqlJournal.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `SqlJournalOptions` | interface | `capacity`, `overflow`, `batchSize`, `sourceEventCache`, `redact`, `compaction` |
| `CompactionPolicy` | interface | opt-in threshold-driven checkpoint-and-compact; off by default |
| `layer` | layer | scoped writer over `DurableWriter` |

## JournalMetrics

[src/JournalMetrics.ts](https://github.com/smithersai/smithers/blob/main/packages/journal/src/JournalMetrics.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `writes` | counter | `flows_journal_writes`, dimensioned by `channel` and `receipt` |
| `durable`, `lossy` | attributed views | keyed by the receipt tag each channel resolves; `SqlJournal` updates them once per emission receipt |

## OwnerId

[src/OwnerId.ts](https://github.com/smithersai/smithers/blob/main/packages/journal/src/OwnerId.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `OwnerId` | schema + type | `hostId`, `pid`, `nonce`: the fence `emitDurable` accepts; `@smthrs/run-store`'s `Ownership` re-exports it |

## Migrations

[src/Migrations.ts](https://github.com/smithersai/smithers/blob/main/packages/journal/src/Migrations.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `set` | `MigrationSet` | the namespaced set for `flows_journal_events` and `flows_journal_checkpoints`, in id block `0` |
| `run` | effect | apply the journal schema |
| `layer` | layer | applies the journal schema at construction |

Every other durable table belongs to the package that reads it. `@smthrs/database`'s `Migrations` composes the sets, and `@smthrs/engine-store/Migrations` is the composed list a durable engine installs.

## Projection, Redaction

| Export | Source | Notes |
| --- | --- | --- |
| `Projection.Projection`, `Projection.make` | [src/Projection.ts](https://github.com/smithersai/smithers/blob/main/packages/journal/src/Projection.ts) | `initial` plus an effectful `reduce` |
| `Redaction.Rule`, `defaultRules`, `placeholder`, `isSensitiveKey`, `Options`, `redact`, `Redactor`, `make`, `redactJsonString`, `makeNoop` | [src/Redaction.ts](https://github.com/smithersai/smithers/blob/main/packages/journal/src/Redaction.ts) | applied at the single `payload`/`meta` encode chokepoint |

## Test layers

| Export | Source | Notes |
| --- | --- | --- |
| `TestJournal.layer(options?)`, `TestJournal.TestJournalOptions` | [src/test/TestJournal.ts](https://github.com/smithersai/smithers/blob/main/packages/journal/src/test/TestJournal.ts) | the SQL journal over in-memory SQLite; `@smthrs/engine-store/test/TestStores` bundles all four stores over one database |
| `Notifying.wrap`, `Notifying.layer`, `Notifying.Order`, `Notifying.Hook` | [src/test/Notifying.ts](https://github.com/smithersai/smithers/blob/main/packages/journal/src/test/Notifying.ts) | interstitial crash and fence-loss injection around any Effect service |

## API reference

This page is the public API reference for the durable event history. Run and attempt state moved to [`@smthrs/run-store`](/api/run-store) and sealed step results to [`@smthrs/step-cache`](/api/step-cache); flow orchestration is implemented by [`@smthrs/engine-store`](/api/engine-store).

### Journal events

`JournalEvent` exports branded `RunId`, `Seq`, `SourceId`, and `SourceSeq` schemas, plus:

- `Input`: producer event with run/source identity, event type, payload, and optional metadata.
- `Entry`: committed input plus canonical sequence, event ID, and timestamp.
- `makeEventId(runId, sourceId, sourceSeq)`: stable producer-idempotency address.

`Journal` exports the service tag and these operations:

| Operation | Result |
| --- | --- |
| `emitLossy(input)` | Optimistic telemetry receipt; `Dropped` and eviction are accepted outcomes |
| `emitDurable(input)` | `Accepted` or `Duplicate` receipt whose `seq` is already committed |
| `entries({ runId, after?, limit })` | Durable page and `hasMore` |
| `stream({ runId, afterSequence? })` | Replay-then-follow stream |
| `changes` | Scoped subscription to locally committed entries |
| `project(projection, options)` | Stream of accumulated projection states |
| `flush` | Wait until currently accepted queued events commit |

`make`, `makeNoop`, and `layerNoop` construct custom or closed implementations. `JournalError` has stable codes; `OverflowPolicy` is `reject`, `drop-newest`, or `drop-oldest`.

### SQL journal

`SqlJournal.layer(options)` provides the bounded telemetry writer and inline durable writer over `DurableWriter`. Options are `capacity`, `overflow`, and optional `batchSize`, `sourceEventCache`, and `redact`.

#### Source-event index bound

`sourceEventCache` (default `4096`) bounds the in-process producer-idempotency index. The database unique constraint remains authoritative, so eviction changes only whether a retry is recognized before the write transaction. Resident memory and startup decode are O(`sourceEventCache`), not O(total events).

#### Sequence allocation

`emitDurable` allocates both sequences inside the writer's transaction (`MAX(seq) + 1`, taking the in-memory clock as a floor) and inserts the row before returning, so the returned `seq` is already committed. `(run_id, source_id, source_seq)` deduplication is unchanged: an exact producer retry returns `Duplicate` with `status: "committed"`, and a reused producer sequence carrying different content fails with `idempotency_conflict`. Use it wherever a caller acts on the returned sequence: lifecycle finalization, cross-process supervisors, or any deployment where a second writer may open the same run. A durable boundary must not advance the run or expose its result until this commit returns.

#### `transact`, one transaction for the entry and the state it describes

Committing an entry makes that entry durable; it does not by itself make flows' whole view crash-consistent, because the executable state lives in `RunStore`, `AttemptStore`, `CacheStore`, and `DurableEngineState`. `transact` closes that seam:

```ts
yield* journal.transact(Effect.gen(function*() {
  const finished = yield* attempts.finish(row, owner)
  if (finished._tag !== "Finished") return false
  yield* journal.emitDurable(attemptFinished, owner)
  return true
}))
```

Those stores write through the same `DurableWriter`, so their writes join this transaction as savepoints: the row and its lifecycle entry either both commit or both roll back. Engine-store uses it for every lifecycle pair it writes, which is what makes the journal an account of record rather than a best-effort echo. The prior art is Temporal, which closes mutable state into a mutation plus event batches and submits them as one persistence request (`reference/temporal/service/history/workflow/transaction_impl.go`).

Three properties matter to callers:

- **Publication follows COMMIT.** Inside a transaction, `emitDurable` returning means a savepoint was released. The `changes`/`stream` publish and the in-process producer index update are parked until the outermost transaction commits, so a subscriber never sees an entry that later rolls back, and a rolled-back producer identity stays re-emittable instead of deduplicating against a sequence that does not exist.
- **Only storage work belongs inside.** The transaction is held for its whole body: no flow bodies, host calls, or `flush` (which waits on the lossy writer and would deadlock against the open transaction).
- **Nesting is a savepoint.** An inner `transact` defers its settlements to the outermost commit.

A crash before COMMIT still loses the whole unit, so work that had already run, an action body, for instance, re-executes on the next drive. And no local transaction makes a remote effect atomic, so external effects still need idempotency keys, fencing tokens, or compensation.

Stated deviation from smithers (`packages/db/src/adapter.js`), which allocates under `BEGIN IMMEDIATE`: the SQLite backends we ship give Effect's SQL client no `beginTransaction` hook, so `DurableWriter.write` opens the default DEFERRED transaction. The floor read holds a shared lock and the INSERT upgrades it; under WAL a concurrent writer makes that upgrade fail `SQLITE_BUSY_SNAPSHOT`, which the database package classifies as retryable and replays the whole transaction, floor read included, against the committed snapshot. Allocation is therefore conflict-free by retry, not by lock escalation, and `packages/journal/test/JournalDurable.test.ts` proves it with two connections writing one run concurrently and with a cold-restart floor case.

Because that transaction both replays and can abort at COMMIT, `emitDurable` mutates the in-memory clock and publishes to `changes`/the per-run wake PubSub strictly *after* the transaction returns, exactly as the queued path publishes outside `persistBatch`. A rolled-back write is never observable to a subscriber and never becomes an allocation floor.

Every write funnels through one preparation step, and that step redacts: `payload` and `meta` are scrubbed by `Redaction.make()` before they are encoded, so no channel can persist a credential. Fields whose names read as credentials (`apiKey`, `authorization`, `cookie`, `token`, `password`, `secret`, and separator/case variants) are replaced wholesale; provider keys, bearer tokens, and `SECRET=value` assignments are replaced inside any string. Rows are permanent and are replayed verbatim to sync subscribers and time-travel consumers, so redaction on write is the only place it can be enforced once. Pass `redact: Redaction.makeNoop()` to `SqlJournal.layer` to persist payloads verbatim by choice.

Redaction stops at the journal. It is an **observability** concern, and journal rows exist to be read: by sync subscribers, by time-travel consumers, by a support bundle. The stores in [`@smthrs/run-store`](/api/run-store) and [`@smthrs/step-cache`](/api/step-cache) hold *executable* state and are deliberately not redacted; those pages state why, and neither takes a `redact` option at all.

A value that must never reach durable executable state is a typed boundary, not a guess made at the storage seam: model it as a `Redacted` field in the flow's own state schema, so the encoder drops it by declaration and the decoder knows it is absent. For rendering a stored column to a human, `Redaction.redactJsonString` scrubs an already-encoded JSON string at the display surface, leaving the durable row untouched.

The two channels also fail independently, and neither failure is permanent. A batch the optimistic writer cannot persist is lost and reported, to the `flush` waiters that covered it, to live `stream` consumers that were following when it happened, and, if nobody was waiting, to the next `flush`, but the writer fiber survives it. Each loss is reported once; a later `flush` with nothing outstanding succeeds, while entries queued behind the lost batch stay outstanding, only the destroyed batch leaves the pending set, so a subsequent `flush` still waits for them instead of vouching for unpersisted work, so a single transient outage cannot stall the durable delivery paths in `engine-store` that call `flush` after `emitDurable`. `emitDurable` was never gated by it: it opens its own transaction inline, so the lossless lifecycle channel keeps working as soon as the database is healthy again.

#### Migrations

`Migrations.set` is the journal's namespaced migration set, `flows_journal_events` and its event-type index, and reserves migration id block `0`. `Migrations.run` / `Migrations.layer` install it alone. Every other durable table belongs to the package that reads it, and `@smthrs/database`'s `Migrations` composes those sets over one `flows_migrations` table, namespacing each package's ids into a reserved block so two packages' `0001_initial` cannot collide; `@smthrs/engine-store/Migrations` is the composed list a durable engine installs. The repository is unreleased, so each package has one authoritative initial schema rather than compatibility migrations for obsolete internal versions.

### Ownership token

`OwnerId.OwnerId` contains `hostId`, `pid`, and `nonce`. It lives here rather than with the arbitration in `@smthrs/run-store` because the journal is what it fences: `emitDurable(input, owner)` only lands the row while `flows_runs` still records that owner as the running run's owner, and otherwise fails `fence_lost`. `@smthrs/run-store`'s `Ownership` re-exports it alongside `LivenessEvidence`, `LivenessProbe`, and the heartbeat constants.

### Projections and tests

`Projection.make` is an identity constructor for `{ name, initial, reduce }`. `TestJournal.layer(options?)`, imported from `@smthrs/journal/test/TestJournal`, not the root, provides the migrated SQL journal over in-memory SQLite. For the journal, run, attempt, and cache services over ONE database, take `@smthrs/engine-store/test/TestStores`.

### Entry points

The root holds the journal and its contracts, written against the driver-neutral `@smthrs/database` service, and it bundles for the browser (`pnpm run browser`). The test doubles bind a Node SQLite database and are therefore imported from `@smthrs/journal/test/TestJournal` and `@smthrs/journal/test/Notifying`. See [browser support](/architecture/browser-support).

See [Journal semantics](/concepts/journal), [Concurrency](/concepts/concurrency), and the [`@smthrs/engine-store` reference](/api/engine-store).
