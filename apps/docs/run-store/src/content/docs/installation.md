---
title: "Installation"
description: "Install @smthrs/run-store, the SQL driver and durable writer it needs, its import forms, and the subpaths that are deliberately not public."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/run-store/docs/installation.md"
---

## Install the package

```bash
pnpm add @smthrs/run-store
```

The package requires Node.js 22.19.0 or later and ships as both ESM and
CommonJS with TypeScript declarations. Its runtime dependencies install with
it: [`@smthrs/database`](https://database.smithers.sh/reference/api/) for the durable write contract,
[`@smthrs/journal`](https://journal.smithers.sh/reference/api/) for the `OwnerId` fencing token,
[`@smthrs/observability`](https://observability.smithers.sh/reference/api/) for the shared throughput metric,
and [`effect`](https://effect.website).

## What a working composition adds

The stores are written against the driver-neutral `@smthrs/database` contract,
so they carry no database of their own. A composition supplies two services:

- `SqlClient.SqlClient` from `effect/unstable/sql/SqlClient`, which the SQL
  driver provides. `@smthrs/database/node/NodeDatabase` opens a `node:sqlite`
  database.
- `DurableWriter` from `@smthrs/database`, which serializes and retries the
  write transactions the stores run inside.

Both `RunStore.layer` and `AttemptStore.layer` require exactly those two, and
`Migrations.layer` requires the `SqlClient` alone. The layer order that
satisfies them is in [Compose the stores into a host](/guides/compose-the-stores/).

Most hosts do not wire this by hand. [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/)
composes these stores with the journal, the step cache, and the durable engine
state into one storage ladder, and `@smthrs/flows/NodeRuntime` builds that
ladder over a single SQLite file.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { AttemptStore, Migrations, Ownership, RunStore, RunStoreMetrics } from "@smthrs/run-store"
```

Each module is also importable from its own subpath, which is the form the API
reference uses:

```ts
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as RunStore from "@smthrs/run-store/RunStore"
```

Both forms reach the same modules. The root is driver-neutral and bundles for
the browser: nothing under it imports a `node:` built-in.

## The two subpaths that are not namespaces of the root

| Import                                | Platform | What it holds                                                                                                                  |
| ------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `@smthrs/run-store/Heartbeat`         | any      | The four lease durations: `heartbeatInterval`, `heartbeatStaleAfter`, `heartbeatSkewAllowance`, and `heartbeatWriteTolerance`. |
| `@smthrs/run-store/test/TestRunStore` | Node     | `layer`, which provides migrated in-memory `RunStore` and `AttemptStore` services.                                             |

`Ownership` re-exports all four durations, so the `Heartbeat` leaf exists for a
consumer that wants the numbers and no store at all:

```ts
import * as Heartbeat from "@smthrs/run-store/Heartbeat"
import * as TestRunStore from "@smthrs/run-store/test/TestRunStore"
```

`@smthrs/run-store/package.json` is exported. Three subpath families are
blocked in the export map and are not public API: `internal/*`, `migrations/*`,
and nested `*/index`. The migration implementations are blocked because the set
is the contract; import `Migrations.set` rather than a numbered file.

## Next step

Run a full lifecycle against an in-memory database in the
[Quickstart](/quickstart/).
