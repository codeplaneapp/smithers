---
title: "@smthrs/database"
description: "The durable write boundary under every Smithers storage package: one transaction policy, one normalized failure vocabulary, and the namespaced migration ladder that lets many packages share one SQLite file."
---

`@smthrs/database` is the seam between the Smithers storage packages and the
SQL database underneath them. It owns three things and deliberately nothing
else:

- **`DurableWriter`**, one combinator that runs an effect inside one
  transaction with bounded retries on transient conflicts, under a written
  serialization contract every backend must satisfy.
- **A normalized failure vocabulary.** `DatabaseError` reports `busy`,
  `constraint`, `io`, `unsupported`, or `unknown`, so store code never branches
  on a driver's own codes.
- **`Migrations`**, which composes one migration set per package over a single
  `flows_migrations` table without the packages colliding.

Reads do not come here. Queries use Effect's own `SqlClient` service directly,
and the tables and their SQL belong to the packages that own them:
[`@smthrs/journal`](/api/journal), [`@smthrs/run-store`](/api/run-store),
[`@smthrs/step-cache`](/api/step-cache), and
[`@smthrs/engine-store`](/api/engine-store).

## The problem it solves

Six packages write to one SQLite file. Each needs the same three guarantees,
and each would otherwise reimplement them slightly differently:

1. A write that loses a lock race must replay, not fail the run. A write that
   violates a constraint must not replay, because replaying cannot fix it.
2. A store call nested inside another store's transaction must commit or roll
   back with it, and the retry must belong to the outermost transaction alone.
3. Two packages that both ship an `0001_initial` migration must migrate to
   distinct identities instead of one silently shadowing the other.

One boundary supplies all three, so a store's code says what it means and the
policy is auditable in one file.

## Install

```bash
pnpm add @smthrs/database effect
```

See [Installation](./installation.md) for the peer requirements and the import
forms.

## The shortest real example

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"

const program = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const writer = yield* DurableWriter.DurableWriter
  return yield* writer.write(sql`SELECT 1 AS value`)
})

const database = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: "flows.sqlite" })
)

Effect.runPromise(program.pipe(Effect.provide(database), Effect.scoped))
```

`NodeDatabase.layer` provides the SQL client and nothing else.
`DurableWriter.layer` adds the write policy on top. Any Effect `SqlClient`
works underneath it, so the retry classification and the error vocabulary are
the same whichever driver you compose.

## The package at a glance

The root entry point is driver neutral and bundles for browsers. Each driver is
platform specific and lives at an explicit subpath.

| Import                                | What it gives you                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `@smthrs/database`                    | The four driver-neutral namespaces: `DurableWriter`, `Migrations`, `DatabaseMetrics`, `UnsupportedBackend`. |
| `@smthrs/database/DurableWriter`      | The write boundary, `DatabaseError`, `fromSqlError`, `affectedRows`, and the layers.                        |
| `@smthrs/database/Migrations`         | `MigrationSet`, `idBlock`, `table`, and the `loader`, `run`, and `layer` composers.                         |
| `@smthrs/database/DatabaseMetrics`    | The `flows_db_write_retries` counter.                                                                       |
| `@smthrs/database/UnsupportedBackend` | The `SMITHERS_POSTGRES_*` names 1.0.0-rc.0 ignores, and the notice each one gets.                           |
| `@smthrs/database/node/NodeDatabase`  | Node only. The `node:sqlite` client layer and the three opens rc.0 refuses.                                 |
| `@smthrs/database/test/TestDatabase`  | Node only. The client and the writer over a fresh `:memory:` database.                                      |

Every export, with signatures and failure types, is on the
[API reference](./api.md).

## Where to go next

- [Installation](./installation.md): requirements, subpaths, and what a real
  composition adds.
- [Quickstart](./quickstart.md): migrate a fresh SQLite file and write through
  the boundary, end to end.
- Concepts: [the write boundary](./concepts/write-boundary.md),
  [the migration ladder](./concepts/migration-ladder.md), and
  [why rc.0 is SQLite only](./concepts/sqlite-only.md).
- Guides: [compose a database layer](./guides/compose-a-database.md),
  [add a migration](./guides/add-a-migration.md),
  [handle a failed write](./guides/handle-a-failed-write.md),
  [read a write's affected-row count](./guides/count-affected-rows.md),
  [test against a database](./guides/test-against-a-database.md), and
  [add a backend driver](./guides/add-a-backend.md).
- [Troubleshooting](./troubleshooting.md): every message this package produces,
  what causes it, and what to change.
