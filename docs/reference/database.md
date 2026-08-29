# `@smthrs/database`

This page is the public API reference for the durable write boundary. `@smthrs/database` owns driver composition, the shared write policy, and normalized database failures; domain tables and queries belong to the packages that read them — `@smthrs/journal`, `@smthrs/run-store`, `@smthrs/step-cache`, and `@smthrs/engine-store`. Queries use Effect's own `SqlClient` service directly — this package adds only the write policy on top of it.

## Import

The root is the driver-neutral contract and bundles for the browser; the SQLite drivers are Node-only and live under their own subpaths (see [browser support](../architecture/browser-support.md)).

```ts
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
```

## `DurableWriter`

| Export | Purpose |
| --- | --- |
| `DurableWriter` | Effect service tag exposing `write` |
| `Service` | Structural service interface |
| `DatabaseError` | Schema-tagged failure with `code` and optional `cause` |
| `DatabaseErrorCode` | `busy`, `constraint`, `io`, `unsupported`, or `unknown` |
| `make(sql, options?)` | Build the writer over an existing Effect `SqlClient` |
| `layer(options?)` | Provide the writer over the context's `SqlClient` |
| `fromSqlError(error)` | Normalize an Effect SQL error |
| `affectedRows(raw)` | Read a write's affected-row count from any driver's raw result |
| `makeNoop()` | Unsupported writer stub |
| `layerNoop` | Layer for the unsupported stub |

`DurableWriter.write(effect)` runs `effect` through `sql.withTransaction` and applies bounded retry to retryable writes. The retry classifier is deliberately dialect-blind: it recognizes the SQLite lock/busy/IO codes *and* the Postgres transient SQLSTATEs (`40001` serialization_failure, `40P01` deadlock_detected, `55P03` lock_not_available, plus the text forms PGlite raises without a SQLSTATE), and `fromSqlError` normalizes both onto the same `busy` code. `DurableWriter.make` accepts any `SqlClient`, so a caller-supplied Postgres or PGlite client gets the retry behaviour rather than silently getting none (issue #78). A unique violation is never retried — it is the first-writer-wins signal the stores decide on. Other SQL failures are normalized without retry.

**Retries belong to the outermost transaction.** A `write` nested inside another `write` joins the enclosing transaction as a savepoint and does not retry: a transient conflict dooms the enclosing transaction's snapshot, so replaying the savepoint alone can never resolve it. Only the outermost `write` retries, replaying the whole transaction body verbatim. Its classifier follows `cause` chains, so a store that has already normalized a savepoint failure into its own error type (a `RunStoreError` wrapping a `DatabaseError` wrapping the SQL failure) still keeps the outermost transaction replaying. This is what makes `Journal.transact` — a state projection and its lifecycle entry in one transaction — retryable as a unit.

**Serialization is part of the `write` contract, not an incidental property.** An implementation MUST guarantee that two concurrent `write` transactions are mutually serialized: they may not both commit results computed from snapshots that exclude each other's writes. Consumers rely on this for correctness rather than isolation hygiene — the engine store closes a run-parent edge by inserting into a table whose `PRIMARY KEY (child_id, parent_id)` supplies the uniqueness and then walking the ancestor graph *inside the same* `write`, and its safety argument ("of two edges that jointly close a cycle, exactly the later one fails") holds only under serialized writers. SQLite meets the contract with its single-writer transaction lock. A PostgreSQL- or PGlite-backed implementation must run write transactions at `SERIALIZABLE` and retry `40001` (which the dialect-blind classifier above already does); plain `READ COMMITTED` does not satisfy the contract, and adopting it would silently reintroduce the cycle race (issue #74).

The contract is pinned by a reusable conformance suite: `packages/database/test/contract/DatabaseWriteContract.ts` exports `describeContract(harness)`, and `test/DatabaseWriteContract.test.ts` runs it against two `NodeDatabase` connections over one file and against the shared in-memory `TestDatabase` connection. **A new backend layer is not done until it is added there** — a harness supplies two `DurableWriter` services over one store, and the suite checks no lost update on a concurrent read-modify-write, exactly one winner for two check-then-insert writers over a table with no unique index, cross-connection visibility of a committed write, and whole-transaction rollback. A `READ COMMITTED` implementation fails the first three (issue #97), and a backend whose affected-row count is unreadable fails the delete cell (issue #134).

`affectedRows(raw)` reads how many rows a write touched out of the driver's native `.raw` result: SQLite drivers report `changes`, node-postgres reports `rowCount`, and a shape carrying neither fails with `unsupported` rather than reading as zero. Affected-row counts are part of the backend contract, not a driver detail — the journal's fenced cache eviction decides whether its compare-and-swap hit from this count alone, so a silent `undefined` would report every successful fenced delete as a no-op. The conformance suite pins the contract with a delete that matches a row and one that matches none (issue #134).

```ts
const save = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const writer = yield* DurableWriter.DurableWriter
  yield* writer.write(sql`insert into items (id) values (${id})`)
})
```

## `NodeDatabase`

**Node only** — `@smthrs/database/node/NodeDatabase`, not a root export.

`NodeDatabase.layer({ filename, sqlite? })` provides Effect's `SqlClient` over `@effect/sql-sqlite-node` — connection options only; retry tuning belongs to `DurableWriter.layer(options)`, composed on top with `Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))`. The underlying client enables WAL by default unless its configuration overrides that behavior.

Opening the connection is retried while SQLite reports the database as locked. The client opens the file and issues `PRAGMA journal_mode = WAL` inside its constructor with no busy timeout, so two processes opening one file concurrently can collide there — either on the WAL conversion itself (SQLite refuses a mode change while another connection holds the file, and refuses immediately, without consulting the busy handler) or with `SQLITE_BUSY_RECOVERY` while a peer recovers the log. Both arrive as construction-time defects rather than the `SqlError` values `WriteRetry` classifies, so they are handled at the layer instead. Both clear once the peer finishes; a defect that is not a lock is raised on the first attempt.

```ts
const DatabaseLayer = NodeDatabase.layer({
  filename: "./flows.sqlite"
})
```

## `TestDatabase`

**Node only** — `@smthrs/database/test/TestDatabase`, not a root export. `TestDatabase.layer` is `DurableWriter.layer()` over `NodeDatabase.layer({ filename: ":memory:" })`, providing both the client and the writer. It is deterministic within one layer scope and has no restart durability.

## Runtime notes

The database service does not run domain migrations. Compose [`Journal.Migrations.layer`](journal.md#migrations) before exposing journal stores.

**The shipped backend is Node SQLite only.** `NodeDatabase` wraps `@effect/sql-sqlite-node`. The browser package root exposes the driver-neutral contract, but no browser SQL client layer ships here. There is no `PgDatabase`/`PGliteDatabase` layer, and the journal schema is SQLite-flavoured DDL, so a Postgres client wrapped by `DurableWriter.make` gets correct retry classification but not a runnable schema. This is an accepted, documented gap with a plan — see gap 4 in [`../architecture/smithers-replacement-gaps.md`](../architecture/smithers-replacement-gaps.md).

## Migrations

`Migrations` composes those packages' migration sets over one `flows_migrations` table. A `MigrationSet` declares a `namespace` that prefixes its migration names and an `idOffset` — a multiple of `idBlock` (1000) — that reserves a block of migration ids, so two packages that both ship an `0001_initial` land on distinct identities instead of colliding or, worse, silently shadowing one another through a merged record. `loader(sets)` rejects a duplicate namespace, a duplicate offset, a malformed key, and any id collision the offsets failed to prevent; `run(sets)` and `layer(sets)` apply them in id order. It also rejects the second way a block scheme can lose a table: Effect's `Migrator` decides what to run from a single high-water mark, so a migration whose id sits at or below the highest id the database already applied would be assumed done and never run — migrating a database with the `2000` block alone and then composing every set would otherwise leave the `0` and `1000` blocks' tables uncreated. That fails loudly instead. `@smthrs/engine-store/Migrations` is the composed list a durable engine installs.

See [Assembling a durable engine](../guides/durable-engine.md) and the [`@smthrs/journal`](journal.md), [`@smthrs/run-store`](run-store.md), and [`@smthrs/step-cache`](step-cache.md) references.
