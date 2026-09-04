import { Duration, Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as DurableWriter from "../src/DurableWriter.ts"
import * as NodeDatabase from "../src/node/NodeDatabase.ts"
import { describeContract, type Harness } from "./contract/DatabaseWriteContract.ts"

/** Builds one real client/writer pair and keeps its connection open for the scope. */
const connect = (filename: string) =>
  Effect.gen(function*() {
    const context = yield* Layer.build(
      NodeDatabase.layer({
        filename,
        sqlite: { busyTimeout: Duration.millis(5) }
      }) as unknown as Layer.Layer<never>
    )
    const sql = yield* (Effect.service(SqlClient.SqlClient).pipe(
      Effect.provide(context as never)
    ) as Effect.Effect<SqlClient.SqlClient>)
    const writer = DurableWriter.make(sql)
    return { sql, write: writer.write }
  })

/**
 * The production Node path: two independent connections over one database
 * file, so serialization can only come from SQLite's cross-connection lock.
 */
const nodeFileHarness: Harness = {
  label: "NodeDatabase, two connections over one file",
  realDriver: true,
  crossConnection: true,
  run: (body) =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "flows-db-contract-"))),
      (directory) =>
        Effect.scoped(Effect.gen(function*() {
          const filename = join(directory, "contract.sqlite")
          const a = yield* connect(filename)
          const b = yield* connect(filename)
          return yield* body({ a, b })
        })),
      (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
    )
}

describeContract(nodeFileHarness)
