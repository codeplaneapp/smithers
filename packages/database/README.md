# @smthrs/database

Durable write boundary for the Smithers persistence packages. It provides the
shared write policy (`DurableWriter`), normalized database failures, and
Node, Cloudflare Durable Object, and in-memory SQLite client layers; queries go
through Effect's own `SqlClient` service, and journal schema and queries stay
in `@smthrs/journal`.

```sh
pnpm add @smthrs/database
```

## Public API

The root is the driver-neutral contract and bundles for the browser. Each
driver is platform-specific, so they live under explicit subpaths.

| Import                                              | Public exports                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@smthrs/database`                                  | Four namespaces. `DurableWriter` exposes transaction-scoped `write(effect)` plus `DatabaseError`, `fromSqlError`, `affectedRows`, `WriteRetryOptions`, and the `make`/`layer`/`makeNoop`/`layerNoop` constructors. `Migrations` composes per-package migration sets over one table. `DatabaseMetrics` declares `writeRetries`. `UnsupportedBackend` is a root namespace as well as a subpath. |
| `@smthrs/database/node/NodeDatabase`                | **Node only.** `NodeDatabaseOptions` configures the SQLite connection; `layer(options)` provides Effect's `SqlClient`. `UnsupportedDatabase`, `UnsupportedDatabaseCode`, and `isUnsupportedDatabase` describe the three opens 1.0.0-rc.0 refuses.                                                                                                                                             |
| `@smthrs/database/UnsupportedBackend`               | `ignoredNames(environment)` lists the `SMITHERS_TEST_PG_URL` and `SMITHERS_POSTGRES*` names 1.0.0-rc.0 ignores; `ignoredNotice(name)` is the one line each of them gets. Browser-safe: strings only.                                                                                                                                                                                          |
| `@smthrs/database/cloudflare/DurableObjectDatabase` | **Cloudflare Workers only.** `DurableObjectDatabaseOptions` takes the object's `ctx.storage`; `make` and `layer(options)` provide Effect's `SqlClient` over its SQLite storage.                                                                                                                                                                                                               |
| `@smthrs/database/cloudflare/SqlStorageLike`        | The structural view of `ctx.storage` the driver is typed against, so no consumer needs `@cloudflare/workers-types` to satisfy it.                                                                                                                                                                                                                                                             |
| `@smthrs/database/test/TestDatabase`                | **Node only.** `layer` provides the production Node client and the writer over a fresh `:memory:` database.                                                                                                                                                                                                                                                                                   |
| `@smthrs/database/test/DurableObjectStorageFake`    | **Node only.** `make()` returns an in-process fake of `ctx.storage` over `node:sqlite`, so Durable Object code is testable without workerd.                                                                                                                                                                                                                                                   |

Any Effect `SqlClient` works underneath `DurableWriter.layer()`, so a browser or
Postgres client gets the same normalized errors and write retry. See
[browser support](../../docs/pages/architecture/browser-support.md).

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

Effect.runPromise(program)
```

SQLite busy, locked, and lock-timeout writes are retried. I/O errors are
normalized to the `io` code but never replayed, including one whose own cause
chain also mentions a lock, and constraints, syntax errors,
and arbitrary application errors are neither normalized to a transient code nor
replayed. A typed failure must carry an Effect `SqlError` somewhere in its cause
chain to qualify, so an application error whose message quotes database text is
not replayed.

Retries are bounded, and `DurableWriter.layer(options)` takes the bounds as
`WriteRetryOptions`:

| Option        | Default | Meaning                                     |
| ------------- | ------- | ------------------------------------------- |
| `maxAttempts` | `10`    | total attempts, including the initial write |
| `baseDelayMs` | `50`    | initial exponential backoff delay           |
| `maxDelayMs`  | `10000` | upper bound for a single retry delay        |

Jitter is applied before the cap, so `maxDelayMs` bounds the delay actually
slept, and any value that is not a safe integer of at least 1 clamps to 1 rather
than failing. Opening a connection has its own ladder of 40 attempts with a 5 ms
base delay capped at 250 ms; it bounds a driver-internal race during layer
construction, before any service exists to configure, so it is deliberately not
an option.

## Opens that 1.0.0-rc.0 refuses

`NodeDatabase.layer` refuses three opens before it creates a connection, and
raises `UnsupportedDatabase` as a defect in each case. The error channel of
`layer` stays `never`, so every durable package composes it unchanged; match the
defect with `isUnsupportedDatabase` when a command needs to report it.

| Code                        | Refused when                                                    | Message                                                                              |
| --------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `unsupported_runtime`       | `process.versions.bun` is set                                   | `1.0.0-rc.0 runs the durable engine on Node.js >=22.19.0 only`                       |
| `unsupported_database_file` | the file has at least one table and no `flows_migrations` table | `<path> is not a Smithers 1.0 database (1.0.0-rc.0 does not load a 0.x smithers.db)` |
| `database_locked`           | a peer held the file for the whole ladder, so it was never read | `<path> could not be inspected because another process holds it`                     |

The runtime check runs first, so a Bun process learns it is the wrong runtime
rather than something about the file it named. The file check reads
`sqlite_master` through a read-only connection, including for a SQLite `file:`
URI filename, which `node:sqlite` accepts and which would otherwise slip past a
filesystem probe. A URI is probed by its path alone, because its query says how
to open the file rather than which tables the file holds, and a read-only open
of `file:<path>?mode=rw` fails on the mode conflict before reading one. It says
nothing when the file cannot be inspected at all: a
path that does not exist, a directory, an in-memory name, or a file SQLite
refuses to read. None of those is a 0.x database, so the driver's own open
decides what happens next.

A file a peer holds locked is not one of those cases. The probe retries on the
same ladder the open uses, so a 0.x `smithers.db` is refused whether or not a
0.x writer held it at that moment. A lock nobody releases exhausts the ladder,
and that is refused too, with `database_locked`: the open would have waited the
same peer out, so a file rc.0 never read is one it declines to open rather than
one it reports a transient driver error about.

## Environment names 1.0.0-rc.0 ignores

`UnsupportedBackend.ignoredNames(process.env)` lists the connection strings a
0.x PostgreSQL or PGlite deployment exports (`SMITHERS_TEST_PG_URL` and every
`SMITHERS_POSTGRES_*` name), and `ignoredNotice(name)` is the line each one
gets:

```
ignored: SMITHERS_POSTGRES_URL has no effect in 1.0.0-rc.0 (SQLite only)
```

It is a notice, not a refusal: nothing about the run changes, and the exit code
does not move. Ignoring such a name in silence is what the notice exists to
prevent, because a project would otherwise run against SQLite believing it ran
against PostgreSQL. Choosing a backend is the separate case: `SMITHERS_BACKEND`
and `--backend` with any value but `sqlite` exit 1 with `unsupported_database`
(the CLI owns that refusal).

The file check exists because 1.0.0-rc.0 does not load 0.x run state. Without
it, pointing the runtime at a 0.x `smithers.db` would add `flows_*` tables
beside the `_smithers_*` ones and silently mix two schemas. See
[the rc.0 contract](../../docs/migration/rc-contract.md) sections 2 and 6 and
[known limitations](../../docs/pages/release/known-limitations.md).

## Cloudflare Durable Objects

`DurableObjectDatabase.layer({ storage: ctx.storage })` satisfies the same
`DurableWriter` contract, and `test/contract/DatabaseWriteContract.ts` runs
against it. Three platform facts shape it:

- `ctx.storage.sql.exec` is synchronous, so the connection is built out of
  `Effect.try` with no promise and no statement cache.
- The platform reserves `BEGIN`, `COMMIT`, and `ROLLBACK`, so the outermost
  transaction is `ctx.storage.transaction`. `transactionSync` is not usable:
  it commits when its closure _returns_, and a `write` body is an arbitrary
  `Effect` that may suspend.
- An object owns one database on one thread, so write transactions are
  serialized by the client's connection semaphore rather than by a
  database-level lock.

Rows are read positionally and rebuilt against `columnNames`, so a trailing
duplicate column label deterministically overwrites, matching `node:sqlite`
object rows, instead of inheriting the platform cursor's own collapsing rule.
Use `.values` when both columns are needed.

`test/workerd/` runs the platform-specific claims against real workerd behind
`FLOWS_WORKERD_BIN`; see the README there. Everywhere else the driver runs
against `test/DurableObjectStorageFake`, which mirrors the platform over
`node:sqlite`. `@smthrs/flows/CloudflareRuntime` composes the whole engine on
top.

**The subpath is provisional.** rc-contract section 1 and the exclusion table
place Cloudflare engine composition outside rc.0 core, and no disposition row
covers this driver. Until that is resolved, treat
`@smthrs/database/cloudflare/*` as unsupported published surface rather than
part of the frozen contract.

## Why `DurableWriter.write` instead of bare `sql.withTransaction`

`write` is one combinator, not a decorated client: queries use Effect's plain
`SqlClient` directly. The combinator exists because the durable stores
(`@smthrs/journal`, `@smthrs/engine-store`, `@smthrs/time-travel`) share
transaction policy that must live at one boundary:

- **Savepoint composition.** Every store writes through the same `write`, so a
  store call inside `Journal.transact` joins the enclosing transaction as a
  savepoint and defers retries to it: a state transition and the journal entry
  describing it commit or roll back together, and a transient conflict replays
  the whole outermost transaction, never a savepoint alone.
- **Retry classification is domain policy.** Only transient conflicts (SQLite
  busy and locked, Postgres `40001`/`40P01`/`55P03`, and the text forms PGlite
  and Durable Object SQLite raise without a code) are replayed. A SQLite I/O
  error is normalized to `io` and not replayed, and a unique violation is never
  retried because it is the first-writer-wins signal the stores branch on. The
  classifier follows `cause` chains, so a store error wrapping a savepoint
  failure still replays the outermost transaction, and it is the same call
  `fromSqlError` makes, so the code a caller receives after the budget is
  exhausted always names the category the budget was spent on. An I/O failure
  that carries a busy cause beneath it is an I/O failure in both answers.
- **A documented serialization contract.** Two concurrent `write` transactions
  are mutually serialized; the engine store's cycle detector is correct only
  under that contract, and `test/contract/DatabaseWriteContract.ts` pins it
  for every backend.
- **One error vocabulary.** `fromSqlError` and `affectedRows` give SQLite,
  PGlite, and Postgres one stable `busy`/`constraint`/`io` vocabulary, so
  store logic never branches on driver-specific codes.

See the [database reference](../../docs/pages/api/database.md) and
[journal concepts](../../docs/pages/concepts/journal.md).
