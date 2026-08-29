# @smthrs/database

Durable write boundary for the flows persistence packages. It provides the
shared write policy (`DurableWriter`), normalized database failures, and
Node/in-memory SQLite client layers; queries go through Effect's own
`SqlClient` service, and journal schema and queries stay in `@smthrs/journal`.

```sh
pnpm add @smthrs/database
```

## Public API

The root is the driver-neutral contract and bundles for the browser. The drivers
are Node-only — `node:sqlite` through `@effect/sql-sqlite-node` — so they live
under explicit subpaths.

| Import                               | Public exports                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@smthrs/database`                   | `DurableWriter` and `Service` expose transaction-scoped `write(effect)`. `DatabaseErrorCode`, `DatabaseError`, and `fromSqlError` normalize driver failures. `make` builds over a SQL client; `layer` composes over the context's `SqlClient`; `makeNoop` and `layerNoop` provide an unsupported stub. |
| `@smthrs/database/node/NodeDatabase` | **Node only.** `NodeDatabaseOptions` configures the SQLite connection; `layer(options)` provides Effect's `SqlClient`.                                                                                                                                                                                 |
| `@smthrs/database/test/TestDatabase` | **Node only.** `layer` provides the production Node client and the writer over a fresh `:memory:` database.                                                                                                                                                                                            |

Any Effect `SqlClient` works underneath `DurableWriter.layer()`, so a browser or
Postgres client gets the same normalized errors and write retry — see
[browser support](../../docs/architecture/browser-support.md).

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

SQLite busy, locked, I/O, and lock-timeout writes are retried. Constraints,
syntax errors, and arbitrary application errors are not.

## Why `DurableWriter.write` instead of bare `sql.withTransaction`

`write` is one combinator, not a decorated client — queries use Effect's plain
`SqlClient` directly. The combinator exists because the durable stores
(`@smthrs/journal`, `@smthrs/engine-store`, `@smthrs/time-travel`) share
transaction policy that must live at one boundary:

- **Savepoint composition.** Every store writes through the same `write`, so a
  store call inside `Journal.transact` joins the enclosing transaction as a
  savepoint and defers retries to it: a state transition and the journal entry
  describing it commit or roll back together, and a transient conflict replays
  the whole outermost transaction, never a savepoint alone.
- **Retry classification is domain policy.** Only transient conflicts (SQLite
  busy/locked/I/O, Postgres `40001`/`40P01`/`55P03`) are replayed. A unique
  violation is never retried — it is the first-writer-wins signal the stores
  branch on. The classifier follows `cause` chains, so a store error wrapping
  a savepoint failure still replays the outermost transaction.
- **A documented serialization contract.** Two concurrent `write` transactions
  are mutually serialized; the engine store's cycle detector is correct only
  under that contract, and `test/contract/DatabaseWriteContract.ts` pins it
  for every backend.
- **One error vocabulary.** `fromSqlError` and `affectedRows` give SQLite,
  PGlite, and Postgres one stable `busy`/`constraint`/`io` vocabulary, so
  store logic never branches on driver-specific codes.

See the [database reference](../../docs/reference/database.md) and
[journal concepts](../../docs/concepts/journal.md).
