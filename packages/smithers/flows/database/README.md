# @smthrs/database

This package declares `effect` as an exact
`4.0.0-rc.108` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://database.smithers.sh

The durable write boundary under the Smithers persistence packages. It owns the
shared write policy (`DurableWriter`), the normalized database failure
vocabulary, the namespaced migration composer, and the Node and in-memory
SQLite client layers. Queries go through Effect's own `SqlClient` service, and
tables and their SQL stay in the packages that own them: `@smthrs/journal`,
`@smthrs/run-store`, `@smthrs/step-cache`, and `@smthrs/engine-store`.

```sh
pnpm add @smthrs/database effect
```

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
`DurableWriter.layer` adds the write policy on top, and it accepts any Effect
`SqlClient`, so the retry classification and the error vocabulary are the same
whichever driver you compose.

## Why writes go through one combinator

Six packages write to one SQLite file, and each would otherwise reimplement the
same three guarantees slightly differently:

- **Serialization is contract.** Two concurrent `write` transactions are
  mutually serialized. The engine store's cycle detector walks the ancestor
  graph inside one `write`, and its safety argument holds only under that
  contract, so `test/contract/DatabaseWriteContract.ts` pins it for every
  backend.
- **Savepoint composition.** A store call inside another store's transaction
  joins it as a savepoint and defers retries to the outermost `write`, which
  replays the whole transaction body. A state transition and the journal entry
  describing it therefore commit or roll back together.
- **Retry classification is domain policy.** Only transient conflicts replay:
  SQLite busy and locked, the Postgres SQLSTATEs, and the text forms drivers
  raise without a code. An I/O failure is normalized to `io` and never
  replayed, and a unique violation is never retried, because it is the
  first-writer-wins signal the stores branch on.

The site at [database.smithers.sh](https://database.smithers.sh) is built from
`docs/`, which is where the contract lives:

- [`docs/README.md`](./docs/README.md): what the package is and where to start.
- [`docs/installation.md`](./docs/installation.md) and
  [`docs/quickstart.md`](./docs/quickstart.md): the requirements, and one
  migrated database end to end.
- [`docs/api.md`](./docs/api.md): every public export, with signatures and
  failure types.
- [`docs/concepts/`](./docs/concepts/write-boundary.md): the write boundary,
  the migration ladder, and why this release is SQLite only.
- [`docs/guides/`](./docs/guides/compose-a-database.md): composing the layers,
  adding a migration, handling a failed write, reading an affected-row count,
  testing, and adding a backend.
- [`docs/troubleshooting.md`](./docs/troubleshooting.md): every message this
  package produces, its cause, and the fix.
