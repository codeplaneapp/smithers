# @smthrs/journal

The flows event journal: the immutable history of what happened, and nothing
else. It owns `flows_journal_events` above `@smthrs/database`, bounded journal
admission, the `OwnerId` fence its durable channel accepts, and the records
consumed by engine-store and sync.

Run and attempt state live in [`@smthrs/run-store`](../run-store), sealed step
results in [`@smthrs/step-cache`](../step-cache), and the durable
deferred/clock tables in [`@smthrs/engine-store`](../engine-store) — see
[`docs/specs/Concepts/Journal Split.md`](../../../docs/specs/Concepts/Journal%20Split.md).

The journal is flows' own **logical (domain) write-ahead log**, intended to
become the authoritative state history.
The SQLite or PostgreSQL WAL beneath it is only the storage durability
substrate and is never consumed as the application event API. Lifecycle
evidence takes `emitDurable`, which commits before it returns, and a durable
boundary must not advance a run or expose its result before that commit.
`emitLossy` is the telemetry channel: bounded, optimistic, lossy by
construction, and never a basis for reconstructing what happened. The
executable state is not derived from the log (see below), but `transact`
commits a transition and its entry together, so the two can never disagree.
Committing locally is not remote atomicity — external effects still need
idempotency keys, fencing tokens, or compensation.

```sh
pnpm add @smthrs/journal
```

## Public API

The root exports these namespaces, also available from matching
`@smthrs/journal/*` subpaths.

| Namespace      | Public exports                                                                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JournalEvent` | Branded schema/types `RunId`, `Seq`, `SourceId`, and `SourceSeq`; input/committed schemas `Input` and `Entry`; deterministic `makeEventId`.                                                                                |
| `Journal`      | `Journal` / `Service` operations `emitLossy`, `emitDurable`, `transact`, `stream`, `entries`, `changes`, `project`, and `flush`; typed errors, receipts, and read options; constructors and no-op layer.                   |
| `SqlJournal`   | `SqlJournalOptions` and database-backed `layer(options)` with explicit lossy and durable channels.                                                                                                                         |
| `Projection`   | Reproducible `Projection` model and identity constructor `make`.                                                                                                                                                           |
| `Redaction`    | The payload redaction applied to journal entries before they are written.                                                                                                                                                  |
| `OwnerId`      | `OwnerId` — `hostId`, `pid`, `nonce` — the fencing token `emitDurable` accepts. Defined here because the journal is what it fences; `@smthrs/run-store`'s `Ownership` re-exports it alongside the arbitration built on it. |
| `Migrations`   | `set` (the namespaced migration set for `flows_journal_events`), `run`, and prerequisite `layer`.                                                                                                                          |

The root is written against the driver-neutral `@smthrs/database` contract
and bundles for the browser. The test doubles bind a Node SQLite database, so
they live under explicit subpaths:

| Import                             | Public exports                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@smthrs/journal/test/TestJournal` | **Node only.** `TestJournalOptions` and `layer(options?)`, providing a migrated in-memory `Journal`. `@smthrs/run-store/test/TestRunStore` and `@smthrs/step-cache/test/TestCacheStore` provide theirs; `@smthrs/engine-store/test/TestStores` provides all four over ONE database. |
| `@smthrs/journal/test/Notifying`   | `Order`, `Hook`, `wrap`, and `layer` inject before/after notifications around Effect-valued service operations.                                                                                                                                                                     |

The single `migrations/0001_initial` module creates this package's table.
`Migrations.run` and `Migrations.layer` install it alone; an application that
also needs run, cache, or engine tables composes `Migrations.set` with the
other packages' sets through `@smthrs/database`'s `Migrations`, which is what
`@smthrs/engine-store/Migrations` already does.

```ts
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Journal, JournalEvent, Migrations, SqlJournal } from "@smthrs/journal"
import { Effect, Layer } from "effect"

const database = NodeDatabase.layer({ filename: "flows.db" })
const journalLayer = SqlJournal.layer({ capacity: 1024, overflow: "reject" }).pipe(
  Layer.provide(Layer.provideMerge(Migrations.layer, database))
)

const program = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  return yield* journal.emitDurable({
    runId: "run-1" as JournalEvent.RunId,
    sourceId: "engine" as JournalEvent.SourceId,
    eventType: "run.created",
    payload: { version: 1 }
  })
}).pipe(Effect.provide(journalLayer))
```

`Seq` is canonical per-run replay order; `SourceSeq` identifies producer
retries. Rejected and dropped admissions may consume either sequence, so gaps
are valid.

`@smthrs/run-store`'s `RunStore` and `AttemptStore` (with `DurableEngineState`
in `@smthrs/engine-store`) hold the executable authoritative state today; it is
not derived from journal entries. `transact` is what keeps the two halves
consistent across the package boundary: it runs a state projection and the
`emitDurable` calls describing it in ONE write transaction — the stores write
through the same `DurableWriter`, so their writes join it as savepoints — and
defers publication until that transaction commits. Either a transition and its
lifecycle entry are both durable, or neither is. See
[implementation status](../../docs/architecture/implementation-status.md).

One coupling outlives the split at the SQL level: a fenced `emitDurable` gates
its insert on a `flows_runs` row still naming the given owner, so the journal
reads a table `@smthrs/run-store` owns. `test/JournalFence.test.ts` pins that
contract here against a fixture of the columns the fence reads;
`@smthrs/engine-store` pins it against the real migrated schema.

See the [journal reference](../../docs/reference/journal.md) and
[journal concepts](../../docs/concepts/journal.md).
