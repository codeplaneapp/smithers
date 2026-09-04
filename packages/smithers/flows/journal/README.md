# @smthrs/journal

**Documentation:** https://journal.smithers.sh

The Smithers event journal: the immutable history of what happened, and nothing
else. It owns `flows_journal_events` and `flows_journal_checkpoints` above
`@smthrs/database`, bounded journal admission, the `OwnerId` fence its durable
channel accepts, and the records consumed by engine-store and sync.

Run and attempt state live in
[`@smthrs/run-store`](https://run-store.smithers.sh/reference/api/), sealed step results in
[`@smthrs/step-cache`](https://step-cache.smithers.sh/reference/api/), and the durable
deferred/clock tables in
[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/).

The journal is Smithers' own **logical (domain) write-ahead log**, intended to
become the authoritative state history. The SQLite WAL beneath it is only the
storage durability substrate and is never consumed as the application event API.
PostgreSQL and PGlite are unsupported at 1.0.0-rc.0; see
[databases](https://smithers.sh/docs/migration/1.0/#databases). Lifecycle
evidence takes `emitDurable`, which commits before it returns, and a durable
boundary must not advance a run or expose its result before that commit.
`emitLossy` is the telemetry channel: bounded, optimistic, lossy by
construction, and never a basis for reconstructing what happened. The executable
state is not derived from the log (see below), but `transact` commits a
transition and its entry together, so the two can never disagree. Committing
locally is not remote atomicity: external effects still need idempotency keys,
fencing tokens, or compensation.

```sh
pnpm add @smthrs/journal
```

## Public API

The root exports these namespaces, also available from matching
`@smthrs/journal/*` subpaths. The generated
[API reference](https://journal.smithers.sh/reference/api/) lists every export with its
one-line summary.

| Namespace        | Public exports                                                                                                                                                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JournalEvent`   | Branded schema/types `RunId`, `Seq`, `SourceId`, and `SourceSeq`; input/committed schemas `Input` and `Entry`; deterministic `makeEventId`.                                                                                                                                                                          |
| `Journal`        | `Journal` / `Service` operations `emitLossy`, `emitDurable`, `emitDurableUnfenced`, `transact`, `stream`, `entries`, `changes`, `project`, `flush`, `checkpoint`, `latestCheckpoint`, and `compact`; the `Checkpoint` and `Compacted` model; typed errors, receipts, and read options; constructors and no-op layer. |
| `SqlJournal`     | `SqlJournalOptions`, `CompactionPolicy`, and database-backed `layer(options)` with explicit lossy and durable channels.                                                                                                                                                                                              |
| `JournalMetrics` | The `flows_journal_writes` counter and the per-channel attributed views `SqlJournal` updates once per emission receipt.                                                                                                                                                                                              |
| `Projection`     | Reproducible `Projection` model and identity constructor `make`.                                                                                                                                                                                                                                                     |
| `Redaction`      | The payload redaction applied to journal entries before they are written.                                                                                                                                                                                                                                            |
| `OwnerId`        | `OwnerId`, carrying `hostId`, `pid`, and `nonce`: the fencing token `emitDurable` accepts. Defined here because the journal is what it fences; `@smthrs/run-store`'s `Ownership` re-exports it alongside the arbitration built on it.                                                                                |
| `Migrations`     | `set` (the namespaced migration set for this package's tables), `run`, and prerequisite `layer`.                                                                                                                                                                                                                     |

The root is written against the driver-neutral `@smthrs/database` contract and
bundles for the browser. The test doubles bind a Node SQLite database, so they
live under explicit subpaths:

| Import                             | Public exports                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@smthrs/journal/test/TestJournal` | **Node only.** `TestJournalOptions` and `layer(options?)`, providing a migrated in-memory `Journal`. `@smthrs/run-store/test/TestRunStore` and `@smthrs/step-cache/test/TestCacheStore` provide theirs; `@smthrs/engine-store/test/TestStores` provides all four over ONE database. |
| `@smthrs/journal/test/Notifying`   | `Order`, `Hook`, `wrap`, and `layer` inject before/after notifications around Effect-valued service operations.                                                                                                                                                                     |

Two migration modules create this package's tables: `0001_initial` creates
`flows_journal_events` and its event-type index, and `0002_checkpoints` creates
`flows_journal_checkpoints`. `Migrations.run` and `Migrations.layer` install
both alone; an application that also needs run, cache, or engine tables composes
`Migrations.set` with the other packages' sets through `@smthrs/database`'s
`Migrations`, which is what `@smthrs/engine-store/Migrations` already does.

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Journal, JournalEvent, Migrations, SqlJournal } from "@smthrs/journal"
import { Effect, Layer } from "effect"

const database = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: "flows.db" })
)
const journalLayer = SqlJournal.layer({ capacity: 1024, overflow: "reject" }).pipe(
  Layer.provide(Layer.provideMerge(Migrations.layer, database))
)

const program = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  return yield* journal.emitDurableUnfenced({
    runId: "run-1" as JournalEvent.RunId,
    sourceId: "engine" as JournalEvent.SourceId,
    eventType: "run.created",
    payload: { version: 1 }
  })
}).pipe(Effect.provide(journalLayer))
```

`SqlJournal.layer` needs both database services: `SqlClient` to read through and
`DurableWriter` to write through.

That example takes `emitDurableUnfenced` because it owns no run and the
composition installs only this package's migrations. `emitDurable` is the fenced
lifecycle write an engine makes:

```ts
const owner = { hostId: "host-1", pid: process.pid, nonce: "run-1-claim" }

const started = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  return yield* journal.emitDurable({
    runId: "run-1" as JournalEvent.RunId,
    sourceId: "engine" as JournalEvent.SourceId,
    eventType: "run.started",
    payload: { attempt: 1 }
  }, owner)
})
```

`emitDurable` requires that fence: the insert lands only while `flows_runs`
still records `owner` as the running run's owner, and otherwise fails
`fence_lost`. `flows_runs` belongs to `@smthrs/run-store`, so a composition that
installs only the journal's migrations fails every fenced call with
`sink_failed` and `no such table: flows_runs`; install `RunStoreMigrations.set`
alongside this package's set, or take `@smthrs/engine-store/Migrations`'s
`sets`. `emitDurableUnfenced` is the sanctioned path for a genuinely ownerless
admission, for example an import or a repair tool. Reaching for it to dodge
`fence_lost` writes exactly the zombie entry the fence exists to reject.

`Seq` is canonical per-run replay order; `SourceSeq` identifies producer
retries. Rejected and dropped admissions may consume either sequence, so gaps
are valid.

## Contracts a caller has to know

**Failure codes.** Every operation fails with a `JournalError` carrying a stable
`code`. `invalid_event` is a contract violation in the caller's own input,
`idempotency_conflict` and `sequence_conflict` are identity collisions,
`fence_lost` is a moved ownership fence, `queue_overflow` and `journal_closed`
are admission states, `sink_failed` and `read_failed` are database failures on
the write and read paths, `decode_failed` is a row that no longer matches the
schema, `checkpoint_invalid`, `reader_behind`, and `compacted` are the
compaction-aware codes (they carry `checkpointSeq`), and `unknown` is reserved
for a genuinely unclassified journal defect.

**Identifiers.** `RunId`, `SourceId`, and both an `Input`'s and a committed
`Entry`'s `eventType` are non-empty, at most 1,024 UTF-16 code units, free of
unpaired UTF-16 surrogates, and free of NUL: SQLite binds a lone surrogate as
U+FFFD, so two ill-formed identifiers would land on one persisted key and
destroy run isolation, and SQLite's `length()` stops at the first NUL, so a
NUL-bearing identifier fails the column's own non-empty check and reports a
caller fault as a sink outage. Valid astral text round-trips exactly. The read
and maintenance methods decode the same schemas, so an identifier the writer
refuses is refused on every read too. `OwnerId.pid` is a non-negative integer,
and an owner that is not an `OwnerId` fails `invalid_event` rather than
degrading into `fence_lost`.

**Idempotency equality.** `(runId, sourceId, sourceSeq)` is the producer
identity. Two emissions under one identity are the same event when their event
type and their canonically encoded, redacted `payload` and `meta` match, so key
order does not matter. The persisted bytes keep `JSON.stringify` semantics, a
`Date` as its ISO string included, because keys are sorted over the ENCODED
JSON rather than over the raw value. Two values that redact to the same bytes
are the same event to the journal, and `NaN` and `null` are the same value.

**Copy and loss semantics.** `changes` is a bounded sliding buffer sized by the
layer's `capacity`: a slow subscriber loses entries with no error and no gap
signal. `stream` is the lossless follower, and it reports a sink loss to every
consumer that was following when it happened. Entries published to `changes` are
frozen, so one subscriber cannot mutate another's view.

**Resource limits.** `capacity` bounds the number of entries in the admission
queue and the size of the `changes` buffer. Run ids, source ids, and event types
are limited to 1,024 UTF-16 code units; `Seq` and `SourceSeq` stop at
`Number.MAX_SAFE_INTEGER - 1`; and `entries` reads at most 10,000 entries per
page. `maxEntryBytes` is the opt-in byte bound: set it and an event whose
encoded `payload` plus `meta` exceeds it fails `invalid_event` before any
sequence is allocated. It is unset by default, so a small number of very large
values can still be the memory bill. Redaction fails a payload deeper than
`Redaction.maxDepth` container edges as `invalid_event` rather than overflowing
the stack, and the canonical encoder carries the same ceiling for a caller who
disables redaction. `sourceEventCache` bounds the in-process
producer-idempotency index; the database unique constraint stays authoritative,
so a miss changes the receipt, not the durable answer: an explicit producer
sequence the index has evicted is admitted without a read and collapses onto
the committed row at insert.

## Consistency across the package boundary

`@smthrs/run-store`'s `RunStore` and `AttemptStore` (with `DurableEngineState`
in `@smthrs/engine-store`) hold the executable authoritative state today; it is
not derived from journal entries. `transact` is what keeps the two halves
consistent across the package boundary: it runs a state projection and the
`emitDurable` calls describing it in ONE write transaction, because the stores
write through the same `DurableWriter` and their writes join it as savepoints,
and it defers publication until that transaction commits. Either a transition
and its lifecycle entry are both durable, or neither is.

One coupling outlives the split at the SQL level: a fenced `emitDurable` gates
its insert on a `flows_runs` row still naming the given owner, so the journal
reads a table `@smthrs/run-store` owns. `test/JournalFence.test.ts` pins that
contract here against a fixture of the columns the fence reads;
`@smthrs/engine-store` pins it against the real migrated schema.

See the [API reference](https://journal.smithers.sh/reference/api/),
[the owner fence](https://journal.smithers.sh/concepts/owner-fence/),
[checkpoints and compaction](https://journal.smithers.sh/concepts/compaction/),
and [troubleshooting](https://journal.smithers.sh/troubleshooting/).

Rewinding SQL histories expose `Journal.Service.generation(runId)`, which reads
`{ generation, afterSeq }` from `flows_journal_generations` (initially zero and
`-1`). The SQL layer installs this table idempotently on existing databases.
Time travel increments the generation in the archive transaction. Append-only
adapters may omit the operation; truncating adapters must implement it. The
`JournalGeneration.initialize` subpath shares the table installation with time
travel without adding a migration below an already applied migration block.
