## What this package owns

`@smthrs/database` owns driver composition, the shared write policy, and the
normalized database failure vocabulary. Domain tables and queries belong to the
packages that read them: `@smthrs/journal`, `@smthrs/run-store`,
`@smthrs/step-cache`, and `@smthrs/engine-store`. Queries use Effect's own
`SqlClient` service directly, and this package adds only the write policy on top
of it.

```ts
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

const program = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const writer = yield* DurableWriter.DurableWriter
  return yield* writer.write(sql`SELECT 1 AS value`)
}).pipe(Effect.provide(
  Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename: "flows.db" }))
))
```

## The `write` contract

`DurableWriter.write(effect)` runs `effect` inside one transaction with
transaction-scoped retries.

**Serialization is part of the contract, not an incidental property.** An
implementation MUST guarantee that two concurrent `write` transactions are
mutually serialized: they may not both commit results computed from snapshots
that exclude each other's writes. Consumers rely on this for correctness rather
than isolation hygiene. The engine store closes a run-parent edge by inserting
into a table whose `PRIMARY KEY (child_id, parent_id)` supplies the uniqueness
and then walking the ancestor graph inside the same `write`, and its safety
argument (of two edges that jointly close a cycle, exactly the later one fails)
holds only under serialized writers. SQLite meets the contract with its
single-writer transaction lock. A PostgreSQL or PGlite implementation must run
write transactions at `SERIALIZABLE` and retry `40001`; plain `READ COMMITTED`
does not satisfy the contract, and adopting it would silently reintroduce the
cycle race.

**Retries belong to the outermost transaction.** A `write` nested inside another
`write` joins the enclosing transaction as a savepoint and does not retry: a
transient conflict dooms the enclosing transaction's snapshot, so replaying the
savepoint alone can never resolve it. Only the outermost `write` retries,
replaying the whole transaction body verbatim against committed state. Its
classifier follows `cause` chains, so a store that has already normalized a
savepoint failure into its own error type still keeps the outermost transaction
replaying. That is what makes `Journal.transact`, a state projection and its
lifecycle entry in one transaction, retryable as a unit.

The contract is pinned by a reusable conformance suite.
`packages/smithers/flows/database/test/contract/DatabaseWriteContract.ts` exports
`describeContract(harness)`, and `test/DatabaseWriteContract.test.ts` runs it
against two `NodeDatabase` connections over one file and against the shared
in-memory `TestDatabase` connection. **A new backend layer is not done until it
is added there.** A harness supplies two `DurableWriter` services over one
store, and the suite checks no lost update on a concurrent read-modify-write,
exactly one winner for two check-then-insert writers over a table with no unique
index, cross-connection visibility of a committed write, and whole-transaction
rollback.

## What is retried, and what is not

Retry classification is deliberately dialect-blind, because `DurableWriter.make`
accepts any `SqlClient` and PGlite and Durable Object SQLite report a failure as
a plain `Error` with no code at all.

| Category   | Recognized as                                                                                                                                                          | Retried |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Busy       | `SQLITE_BUSY*`, `SQLITE_LOCKED*`, `40001`, `40P01`, `55P03`, and the texts `database is locked`, `database is busy`, `could not serialize access`, `deadlock detected` | yes     |
| I/O        | `SQLITE_IOERR*` and the text `disk i/o error`                                                                                                                          | no      |
| Constraint | `ConstraintError` and `UniqueViolation`                                                                                                                                | no      |
| Unknown    | anything else                                                                                                                                                          | no      |

`fromSqlError` maps the busy vocabulary to code `busy`, the I/O vocabulary to
`io`, the constraint vocabulary to `constraint`, and everything else to
`unknown`. **I/O failures are normalized but never replayed.** A unique
violation is never retried either: it is the first-writer-wins signal the stores
decide on.

The two classifiers share one predicate pair, so the code a caller receives
after the budget is exhausted always names the category the budget was spent on.
A typed failure must carry an Effect `SqlError` somewhere in its cause chain to
qualify as retryable, so an application error whose message happens to quote
database text is not replayed. The one exception is the raw rollback defect
Effect 4.0.0-rc.108 raises with no `SqlError` attached, which is matched on the
defect channel alone.

Retries are bounded, and the defaults are:

| Option        | Default | Meaning                                     |
| ------------- | ------- | ------------------------------------------- |
| `maxAttempts` | `10`    | total attempts, including the initial write |
| `baseDelayMs` | `50`    | initial exponential backoff delay           |
| `maxDelayMs`  | `10000` | upper bound for a single retry delay        |

Jitter is applied before the cap, so `maxDelayMs` bounds the delay that is
actually slept. Any value that is not a safe integer of at least 1 clamps to 1
rather than failing, so a mis-tuned option degrades into a single attempt
instead of an unbounded one. Every scheduled replay increments
`flows_db_write_retries`; the attempt that finally fails is not counted.

## Affected-row counts

`affectedRows(raw)` reads how many rows a write touched out of the driver's
native `.raw` result. SQLite drivers report `changes` and node-postgres reports
`rowCount`, so a consumer that casts to one shape silently reads `undefined` on
the other backend and turns a successful compare-and-swap delete into a reported
no-op. A count is accepted as a non-negative safe integer, or as an exact
`bigint` in that range, which is what `node:sqlite` returns when a caller enables
Effect's `SqlClient.SafeIntegers`. Only an own data property counts: an
inherited or accessor-backed `changes` did not come from the statement that ran.
A shape carrying neither field fails with `unsupported`, and the failure carries
only the shape of the offending result, never its values.

## Opens that 1.0.0-rc.0 refuses

`NodeDatabase.layer` refuses three opens before it creates a connection and
raises `UnsupportedDatabase` as a defect in each case. The error channel of
`layer` stays `never`, so every durable package composes it unchanged; match the
defect with `isUnsupportedDatabase` when a command needs to report it.

| Code                        | Refused when                                                    | Message                                                                              |
| --------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `unsupported_runtime`       | `process.versions.bun` is set                                   | `1.0.0-rc.0 runs the durable engine on Node.js >=22.19.0 only`                       |
| `unsupported_database_file` | the file has at least one table and no `flows_migrations` table | `<path> is not a Smithers 1.0 database (1.0.0-rc.0 does not load a 0.x smithers.db)` |
| `database_locked`           | a peer held the file for the whole ladder, so it was never read | `<path> could not be inspected because another process holds it`                     |

The runtime check runs first, so a Bun process learns it is the wrong runtime
rather than something about the file it named. The file check
reads `sqlite_master` through a read-only connection, including for a SQLite
`file:` URI filename, which `node:sqlite` accepts and which would otherwise slip
past a filesystem probe. A URI is probed by its path alone: its query says how
to open the file, never which tables the file holds, and a read-only open of
`file:<path>?mode=rw` fails on the mode conflict before reading one, which would
wave a 0.x database through. It says nothing when the file cannot be inspected
at all: a path that does not exist, a directory, an in-memory name, or a file
SQLite refuses to read. None of those is a 0.x database, so the driver's own
open decides what happens next.

A file a peer holds locked is not one of those cases. The probe retries on the
same ladder the open uses, so a 0.x `smithers.db` is refused whether or not a
0.x writer held it at that moment. A lock nobody releases exhausts the ladder,
and that is refused too, with `database_locked`.

Opening is retried because the client issues `PRAGMA journal_mode = WAL` inside
its constructor, and SQLite performs that mode change only with the file to
itself. The client sets `PRAGMA busy_timeout` first and the mode change does
honour it: measured on `node:sqlite` against a peer holding a shared read lock,
the conversion waits the whole timeout and then fails with `database is locked`.
A lock that outlasts the timeout still fails, and so does `SQLITE_BUSY_RECOVERY`
while a peer recovers the log. Both arrive as construction-time defects rather
than the `SqlError` values the write retry classifies, so they are handled at
the layer instead, on a fixed ladder of 40 attempts with a 5 ms base delay
capped at 250 ms. Because a contended attempt can spend up to the configured
`busyTimeout` inside SQLite before that delay, the ladder's wall-clock cost is
bounded by the timeout, not by the delays. The ladder is deliberately not
configurable: it bounds a driver-internal race during layer construction, before
any service exists to configure.

## Environment names 1.0.0-rc.0 ignores

`UnsupportedBackend.ignoredNames(process.env)` lists the connection strings a
0.x PostgreSQL or PGlite deployment exports, `SMITHERS_TEST_PG_URL` and every
`SMITHERS_POSTGRES_*` name, and `ignoredNotice(name)` is the line each one gets:

```
ignored: SMITHERS_POSTGRES_URL has no effect in 1.0.0-rc.0 (SQLite only)
```

It is a notice, not a refusal: nothing about the run changes and the exit code
does not move. Choosing a backend is the separate case, and `SMITHERS_BACKEND`
or `--backend` with any value but `sqlite` exits 1 with `unsupported_database`,
a refusal the CLI owns.

## Migrations

Every storage package above this one owns its own tables and therefore its own
migrations, but they all migrate one database and record their progress in one
`flows_migrations` table. A `MigrationSet` declares a `namespace` that prefixes
its migration names and an `idOffset`, a multiple of `idBlock` (1000), that
reserves a block of migration ids, so two packages that both ship an
`0001_initial` land on distinct identities instead of colliding or silently
shadowing one another through a merged record.

`loader(sets)` rejects a duplicate namespace, a duplicate offset, an offset that
is not an aligned safe integer, a malformed key, a local id outside its block,
and any realized id collision the offsets failed to prevent. It also rejects the
second way a block scheme can lose a table: Effect's `Migrator` decides what to
run from a single high-water mark, so a migration whose id sits at or below the
highest id the database already applied would be assumed done and never run.
Migrating a database with the `2000` block alone and then composing every set
would otherwise leave the `0` and `1000` blocks' tables uncreated. That fails
loudly instead. The one such skip that is legitimate work, global id zero on a
fresh database, the loader applies itself inside the migrator's transaction.

`run(sets)` and `layer(sets)` apply the composed sets in id order, not in the
order the sets were given, and wrap the whole migrator pass in the same
transient-lock retry the durable writer uses, so two connections migrating one
SQLite file serialize instead of failing on the peer's `BEGIN IMMEDIATE` lock.

The shipped offsets are `journal` at `0`, `run-store` at `idBlock`, `step-cache`
at `idBlock * 2`, `engine-store` at `idBlock * 3`, `plan` at `idBlock * 4`,
`time-travel` at `idBlock * 5`, and `integrations` at `idBlock * 6`.
`@smthrs/engine-store/Migrations` is the composed list a durable engine
installs.

## Dialect status

SQLite is the shipped backend, in both the Node file form and the in-memory test
form.

:::warning
The package root bundles for browsers as a contract, but no browser SQL client
layer ships here. There is no `PgDatabase` or `PGliteDatabase` layer, and the
journal schema is SQLite-flavoured DDL, so a Postgres client wrapped by
`DurableWriter.make` gets correct retry classification but not a runnable
schema. Postgres and PGlite layers, and a dialect-parameterized migration
ladder, are Planned: see [known limitations](/release/known-limitations).
:::

The database service does not run domain migrations. Compose
[`Journal.Migrations.layer`](/api/journal#migrations) before exposing journal
stores. See [Assembling a durable engine](/guides/durable-engine) and the
[`@smthrs/journal`](/api/journal), [`@smthrs/run-store`](/api/run-store), and
[`@smthrs/step-cache`](/api/step-cache) references.
