---
description: "A driver-neutral SQL contract with a bounded write-retry seam, plus the composed migration ladder."
---

# @smthrs/database

A driver-neutral SQL contract with a bounded write-retry seam. The package owns no domain tables.

```ts
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"

const layer = NodeDatabase.layer({ filename: "runs.sqlite" })
```

The root is the contract, so it bundles for the browser. The SQLite drivers are Node-only and live under subpaths.

## Entry points

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/database` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/database/src/index.ts) | any |
| `@smthrs/database/node/NodeDatabase` | [src/node/NodeDatabase.ts](https://github.com/smithersai/smithers/blob/main/packages/database/src/node/NodeDatabase.ts) | Node |
| `@smthrs/database/test/TestDatabase` | [src/test/TestDatabase.ts](https://github.com/smithersai/smithers/blob/main/packages/database/src/test/TestDatabase.ts) | Node |

## DurableWriter

[src/DurableWriter.ts](https://github.com/smithersai/smithers/blob/main/packages/database/src/DurableWriter.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `DurableWriter` | service tag | `@smthrs/database/DurableWriter` |
| `Service` | interface | `sql: SqlClient`, `write: (effect) => Effect` |
| `DatabaseError` | class | carries a `DatabaseErrorCode` |
| `DatabaseErrorCode` | const + type | includes `busy`, `constraint`, `io` |
| `fromSqlError` | function | maps an Effect `SqlError` onto the stable code vocabulary |
| `affectedRows` | function | reads the row count from a driver result |
| `make` | constructor | wraps any Effect `SqlClient` with the retrying `write` |
| `makeNoop` | constructor | every method fails |
| `layerNoop` | layer | |

`write` opens one write transaction and retries the transient categories. Classification covers the SQLite codes and the Postgres SQLSTATEs `40001`, `40P01`, and `55P03` plus PGlite's text forms, normalized onto the same `busy` category.

:::danger
A backend must run write transactions serializably. `packages/database/test/contract/DatabaseWriteContract.ts` is the conformance suite for that requirement.
:::

## DatabaseMetrics

[src/DatabaseMetrics.ts](https://github.com/smithersai/smithers/blob/main/packages/database/src/DatabaseMetrics.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `writeRetries` | counter | `flows_db_write_retries`; one increment per scheduled replay of a transient conflict, so every store writing through `DurableWriter` lands in the same counter |

## Migrations

[src/Migrations.ts](https://github.com/smithersai/smithers/blob/main/packages/database/src/Migrations.ts)

Every storage package declares its own `MigrationSet`; this module composes them over one table so two packages' `0001_initial` cannot collide.

| Export | Kind | Notes |
| --- | --- | --- |
| `table` | const | `"flows_migrations"`, the single ledger every set records into |
| `MigrationSet` | interface | a `namespace` prefixing the set's migration names and an `idOffset` reserving its block of ids |
| `idBlock` | const | `1000`, the block size each package's `idOffset` is a multiple of |
| `loader` | loader | turns a list of sets into an Effect `Migrator.Loader` |
| `run` | migration | applies every set in the order given |
| `layer` | layer | applies them at construction |

The shipped offsets are `journal` at `0`, `run-store` at `idBlock`, `step-cache` at `idBlock * 2`, and `engine-store` at `idBlock * 3`.

## NodeDatabase

[src/node/NodeDatabase.ts](https://github.com/smithersai/smithers/blob/main/packages/database/src/node/NodeDatabase.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `NodeDatabaseOptions` | interface | `filename`, optional `sqlite` config |
| `layer` | layer | `node:sqlite` through `@effect/sql-sqlite-node`, WAL enabled |

`layer` retries connection opening while SQLite reports the file locked, because the driver issues `PRAGMA journal_mode = WAL` inside its constructor and WAL conversion or recovery can race another opener. The current driver also sets `PRAGMA busy_timeout` and uses `BEGIN IMMEDIATE` for writable transactions; see [SQLite operating envelope](/sqlite-operating-envelope) for the operator-facing limits.

## TestDatabase

[src/test/TestDatabase.ts](https://github.com/smithersai/smithers/blob/main/packages/database/src/test/TestDatabase.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `layer` | layer | in-memory SQLite for deterministic suites |

## Dialect status

SQLite is the shipped backend, in both the Node file form and the in-memory test form.

:::warning
The package root bundles for browsers as a contract, but no browser SQL client layer ships here. Postgres and PGlite layers, and a dialect-parameterized migration ladder, are Planned.
:::
