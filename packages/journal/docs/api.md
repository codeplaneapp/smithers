```ts
import { Journal, JournalEvent, Migrations, SqlJournal } from "@smthrs/journal"
import * as Layer from "effect/Layer"

const layer = SqlJournal.layer({ capacity: 1024, overflow: "reject" }).pipe(
  Layer.provideMerge(Migrations.layer)
)
```

## Entry points

| Import                             | Source                                                                                                               | Platform |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------- |
| `@smthrs/journal`                  | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/journal/src/index.ts)                       | any      |
| `@smthrs/journal/test/TestJournal` | [src/test/TestJournal.ts](https://github.com/smithersai/smithers/blob/main/packages/journal/src/test/TestJournal.ts) | Node     |
| `@smthrs/journal/test/Notifying`   | [src/test/Notifying.ts](https://github.com/smithersai/smithers/blob/main/packages/journal/src/test/Notifying.ts)     | any      |

The root holds the journal and its contracts, written against the driver-neutral
`@smthrs/database` service, and it bundles for the browser (`pnpm run browser`).
The test doubles bind a Node SQLite database and are therefore imported from
`@smthrs/journal/test/TestJournal` and `@smthrs/journal/test/Notifying`. See
[browser support](/architecture/browser-support).

## Operations

`Journal.Journal` is the service tag. Every method fails with a `JournalError`
carrying a stable `code`.

| Method                         | Returns                      | Behavior                                                                          |
| ------------------------------ | ---------------------------- | --------------------------------------------------------------------------------- |
| `emitLossy(input)`             | `EmitReceipt`                | bounded non-blocking queue; may return `Dropped`                                  |
| `emitDurable(input, owner)`    | `DurableReceipt`             | allocates and commits inside the write transaction, fenced on `owner`             |
| `emitDurableUnfenced(input)`   | `DurableReceipt`             | the same commit with no fence, for a genuinely ownerless admission                |
| `transact(effect)`             | `A`                          | runs a state projection and its `emitDurable` calls in one transaction            |
| `stream(options)`              | `Stream<Entry>`              | durable history, then committed changes                                           |
| `entries(options)`             | `EntriesPage`                | paged read                                                                        |
| `changes`                      | `PubSub.Subscription<Entry>` | post-commit publication, bounded and sliding                                      |
| `project(projection, options)` | `Stream<S>`                  | folds `stream` through a deterministic reducer                                    |
| `flush`                        | `void`                       | barrier for the lossy queue                                                       |
| `checkpoint(options, owner)`   | `Checkpoint`                 | durably captures replay state at a committed sequence, in `transact`'s discipline |
| `latestCheckpoint(runId)`      | `Option<Checkpoint>`         | the resync point for a compacted run                                              |
| `compact(options, owner)`      | `Compacted`                  | truncates strictly below a checkpoint, atomically with the floor advance          |

`owner` is mandatory on `emitDurable`, `checkpoint`, and `compact`. The insert,
the checkpoint replacement, and the truncation land only while `flows_runs`
still records that owner as the running run's owner, and otherwise fail
`fence_lost`. An owner that is missing, null, or not an `OwnerId` at all fails
`invalid_event` instead: that is a caller contract violation, and reporting it
as `fence_lost` would send the caller hunting a race that never happened.
`emitDurableUnfenced` is the one sanctioned ownerless path, for an import or a
repair tool that owns no run. Reaching for it to dodge `fence_lost` writes
exactly the zombie entry the fence exists to reject.

## Identifiers

`RunId`, `SourceId`, and an `Input`'s `eventType` are non-empty and free of
unpaired UTF-16 surrogates. SQLite binds a lone surrogate as U+FFFD, so two
ill-formed identifiers that differ only in their surrogates would land on one
persisted key: the second run's first event would dedupe into the first run's
row, and a read by either id would return the same history. The schema rejects
them, so an identifier that decodes is an identifier the store can tell apart.
Valid astral text is ordinary text and round-trips exactly.

:::warning
Reads below a run's compaction floor fail with `compacted`. See
[Checkpoints and compaction](/compaction).
:::

## Sequence allocation

`emitDurable` allocates both sequences inside the writer's transaction
(`MAX(seq) + 1`, taking the in-memory clock as a floor) and inserts the row
before returning, so the returned `seq` is already committed. Use it wherever a
caller acts on the returned sequence: lifecycle finalization, cross-process
supervisors, or any deployment where a second writer may open the same run. A
durable boundary must not advance the run or expose its result until this commit
returns.

`Seq` is canonical per-run replay order and `SourceSeq` identifies producer
retries. Rejected and dropped admissions may consume either sequence, so gaps
are valid: allocation is `MAX(seq) + 1` and replay is `ORDER BY seq`, so neither
reads a gap as anything.

## Idempotency equality

`(runId, sourceId, sourceSeq)` is the producer identity, unique in the database
and addressed by the deterministic `makeEventId`. Two emissions under one
identity are the same event when their event type and their canonically encoded,
redacted `payload` and `meta` match. The encoding sorts object keys, so key
order does not change the answer. An exact producer retry returns `Duplicate`
with `status: "committed"`; a reused producer sequence carrying different
content fails `idempotency_conflict`.

Two consequences follow from comparing the persisted, redacted bytes. Two
different secrets that redact to the same placeholder are the same event to the
journal, and `NaN` encodes as `null`. Comparing the pre-redaction value instead
would keep unredacted secrets resident in the in-process index, which is the
leak this package exists to prevent.

## `transact`, one transaction for the entry and the state it describes

Committing an entry makes that entry durable; it does not by itself make flows'
whole view crash-consistent, because the executable state lives in `RunStore`,
`AttemptStore`, `CacheStore`, and `DurableEngineState`. `transact` closes that
seam:

```ts
const finish = Effect.gen(function*() {
  return yield* journal.transact(Effect.gen(function*() {
    const finished = yield* attempts.finish(row, owner)
    if (finished._tag !== "Finished") return false
    yield* journal.emitDurable(attemptFinished, owner)
    return true
  }))
})
```

Those stores write through the same `DurableWriter`, so their writes join this
transaction as savepoints: the row and its lifecycle entry either both commit or
both roll back. Engine-store uses it for every lifecycle pair it writes, which is
what makes the journal an account of record rather than a best-effort echo. The
prior art is Temporal, which closes mutable state into a mutation plus event
batches and submits them as one persistence request
(`reference/temporal/service/history/workflow/transaction_impl.go`).

Three properties matter to callers:

- **Publication follows COMMIT.** Inside a transaction, `emitDurable` returning
  means a savepoint was released. The `changes`/`stream` publish and the
  in-process producer index update are parked until the outermost transaction
  commits, so a subscriber never sees an entry that later rolls back, and a
  rolled-back producer identity stays re-emittable instead of deduplicating
  against a sequence that does not exist.
- **Only storage work belongs inside.** The transaction is held for its whole
  body: no flow bodies, host calls, or `flush`, which waits on the lossy writer
  and would deadlock against the open transaction.
- **Nesting is a savepoint.** An inner `transact` defers its settlements to the
  outermost commit.

A crash before COMMIT still loses the whole unit, so work that had already run,
an action body for instance, re-executes on the next drive. And no local
transaction makes a remote effect atomic, so external effects still need
idempotency keys, fencing tokens, or compensation.

Stated deviation from smithers (`packages/db/src/adapter.js`), which allocates
under `BEGIN IMMEDIATE`: the SQLite backends we ship give Effect's SQL client no
`beginTransaction` hook, so `DurableWriter.write` opens the default DEFERRED
transaction. The floor read holds a shared lock and the INSERT upgrades it; under
WAL a concurrent writer makes that upgrade fail `SQLITE_BUSY_SNAPSHOT`, which the
database package classifies as retryable and replays the whole transaction, floor
read included, against the committed snapshot. Allocation is therefore
conflict-free by retry, not by lock escalation, and
`packages/journal/test/JournalDurable.test.ts` proves it with two connections
writing one run concurrently and with a cold-restart floor case.

Because that transaction both replays and can abort at COMMIT, `emitDurable`
mutates the in-memory clock and publishes to `changes` and the per-run wake
PubSub strictly _after_ the transaction returns, exactly as the queued path
publishes outside `persistBatch`. A rolled-back write is never observable to a
subscriber and never becomes an allocation floor.

## Redaction

Every write funnels through one preparation step, and that step redacts:
`payload` and `meta` are scrubbed by `Redaction.make()` before they are encoded,
so no channel can persist a credential. Fields whose names read as credentials
(`apiKey`, `authorization`, `cookie`, `token`, `password`, `secret`, and
separator and case variants) are replaced wholesale. Provider keys, bearer
tokens, GitHub, AWS, Slack, and Google credentials, URL passwords, `SECRET=value`
assignments, and embedded JSON credential members are replaced inside any string.
The rule set is a best-effort textual net over shapes seen in real reports, not a
proof: a value that must never persist belongs in a `Redacted` field of the
caller's own schema. Rows are permanent and are replayed verbatim to sync
subscribers and time-travel consumers, so redaction on write is the only place it
can be enforced once. Pass `redact: Redaction.makeNoop()` to `SqlJournal.layer`
to persist payloads verbatim by choice.

Redaction stops at the journal. It is an **observability** concern, and journal
rows exist to be read: by sync subscribers, by time-travel consumers, by a
support bundle. The stores in [`@smthrs/run-store`](/api/run-store) and
[`@smthrs/step-cache`](/api/step-cache) hold _executable_ state and are
deliberately not redacted; those pages state why, and neither takes a `redact`
option at all.

For rendering a stored column to a human, `Redaction.redactJsonString` scrubs an
already-encoded JSON string at the display surface, leaving the durable row
untouched. A string that does not parse is returned untouched; a value that
parses and then cannot be re-encoded fails closed, never as the original.

## Failure and loss

`JournalError.code` is stable. `invalid_event` is a contract violation in the
caller's own input, `idempotency_conflict` and `sequence_conflict` are identity
collisions, `fence_lost` is a moved ownership fence, `queue_overflow` and
`journal_closed` are admission states, `sink_failed` and `read_failed` are
database failures on the write and read paths, `decode_failed` is a row that no
longer matches the schema, `checkpoint_invalid`, `reader_behind`, and `compacted`
are the compaction-aware codes and carry `checkpointSeq`, and `unknown` is
reserved for a genuinely unclassified journal defect.

The two channels fail independently, and neither failure is permanent. A batch
the optimistic writer cannot persist is lost and reported: to the `flush` waiters
that covered it, to live `stream` consumers that were following when it happened,
and, if nobody was waiting, to the next `flush`. The writer fiber survives it.
Each loss is reported once; a later `flush` with nothing outstanding succeeds,
while entries queued behind the lost batch stay outstanding, so a subsequent
`flush` still waits for them instead of vouching for unpersisted work. A single
transient outage therefore cannot stall the durable delivery paths in
`engine-store` that call `flush` after `emitDurable`. `emitDurable` was never
gated by it: it opens its own transaction inline, so the lossless lifecycle
channel keeps working as soon as the database is healthy again.

`changes` is a bounded sliding buffer sized by the layer's `capacity`: a slow
subscriber loses entries with no error and no gap signal. `stream` is the
lossless follower. Entries published to `changes` are frozen, so one subscriber
cannot mutate another's view.

## Resource limits

`capacity` bounds the number of entries in the admission queue and the size of
the `changes` buffer. It does not bound bytes, and there is no payload byte cap,
so a small number of very large payloads can still be the memory bill.
`sourceEventCache` (default `4096`) bounds the in-process producer-idempotency
index; the database unique constraint stays authoritative, so eviction changes
performance, not the answer. Resident memory and startup decode are
O(`sourceEventCache`), not O(total events). Redaction traverses at most
`Redaction.maxDepth` container edges and fails a deeper payload as
`invalid_event` rather than overflowing the stack.

## SQL journal

`SqlJournal.layer(options)` provides the bounded telemetry writer and the inline
durable writer over `DurableWriter`. Options are `capacity`, `overflow`, and the
optional `batchSize`, `sourceEventCache`, `redact`, and `compaction`.
`compaction` is off by default: without it the journal never deletes an entry,
and checkpointing stays a caller-driven `checkpoint` and `compact` call. See
[Checkpoints and compaction](/compaction).

## Migrations

`Migrations.set` is the journal's namespaced migration set and reserves
migration id block `0`. `0001_initial` creates `flows_journal_events` and its
event-type index; `0002_checkpoints` creates `flows_journal_checkpoints`.
`Migrations.run` and `Migrations.layer` install them alone. Every other durable
table belongs to the package that reads it, and `@smthrs/database`'s
`Migrations` composes those sets over one `flows_migrations` table, namespacing
each package's ids into a reserved block so two packages' `0001_initial` cannot
collide; `@smthrs/engine-store/Migrations` is the composed list a durable engine
installs. The repository is unreleased, so each package has one authoritative
initial schema rather than compatibility migrations for obsolete internal
versions.

## Ownership token

`OwnerId.OwnerId` contains `hostId`, `pid`, and `nonce`. It lives here rather
than with the arbitration in `@smthrs/run-store` because the journal is what it
fences. `@smthrs/run-store`'s `Ownership` re-exports it alongside
`LivenessEvidence`, `LivenessProbe`, and the heartbeat constants.

## Projections and test layers

`Projection.make` is an identity constructor for `{ name, initial, reduce }`.
`TestJournal.layer(options?)`, imported from `@smthrs/journal/test/TestJournal`
and not from the root, provides the migrated SQL journal over in-memory SQLite
and forwards `capacity`, `overflow`, `batchSize`, `sourceEventCache`, `redact`,
and `compaction`. For the journal, run, attempt, and cache services over ONE
database, take `@smthrs/engine-store/test/TestStores`. `Notifying.wrap` and
`Notifying.layer` inject interstitial crash and fence-loss notifications around
any Effect service.

See [Journal semantics](/concepts/journal), [Concurrency](/concepts/concurrency),
[Checkpoints and compaction](/compaction), and the
[`@smthrs/engine-store` reference](/api/engine-store).
