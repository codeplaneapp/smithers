import { Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableObjectDatabase from "../src/cloudflare/DurableObjectDatabase.ts"
import type { DurableObjectStorageLike } from "../src/cloudflare/SqlStorageLike.ts"
import * as DurableWriter from "../src/DurableWriter.ts"
import * as DurableObjectStorageFake from "../src/test/DurableObjectStorageFake.ts"
import { describeContract, type Harness } from "./contract/DatabaseWriteContract.ts"

/** Builds the client/writer pair a Durable Object holds for its lifetime. */
const connect = (storage: DurableObjectStorageLike) =>
  Effect.gen(function*() {
    const context = yield* Layer.build(
      DurableObjectDatabase.layer({ storage }) as unknown as Layer.Layer<never>
    )
    const sql = yield* (Effect.service(SqlClient.SqlClient).pipe(
      Effect.provide(context as never)
    ) as Effect.Effect<SqlClient.SqlClient>)
    return { sql, write: DurableWriter.make(sql).write }
  })

/**
 * The production Cloudflare path, over the `SqlStorage` fake so it runs
 * everywhere. A Durable Object owns one SQLite database on one thread, so both
 * handles are the same pair by construction and serialization comes from the
 * client's connection semaphore rather than from a database-level lock — the
 * same weaker mechanism the in-memory harness runs on, held to the same
 * contract. `test/workerd/` runs this suite against the real platform.
 */
const durableObjectHarness: Harness = {
  label: "DurableObjectDatabase, one Durable Object over a SqlStorage fake",
  realDriver: true,
  crossConnection: false,
  run: (body) =>
    Effect.acquireUseRelease(
      Effect.sync(DurableObjectStorageFake.make),
      (storage) =>
        Effect.scoped(Effect.gen(function*() {
          const side = yield* connect(storage)
          return yield* body({ a: side, b: side })
        })),
      (storage) => Effect.sync(storage.close)
    )
}

describeContract(durableObjectHarness)
