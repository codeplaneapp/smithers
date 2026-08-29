import { Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableWriter from "../src/DurableWriter.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"
import { describeContract, type Harness } from "./contract/DatabaseWriteContract.ts"

/** Builds one client/writer pair and keeps its connection open for the scope. */
const connect = (layer: Layer.Layer<DurableWriter.DurableWriter | SqlClient.SqlClient>) =>
  Effect.gen(function*() {
    const context = yield* Layer.build(layer as unknown as Layer.Layer<never>)
    const sql = yield* (Effect.service(SqlClient.SqlClient).pipe(
      Effect.provide(context as never)
    ) as Effect.Effect<SqlClient.SqlClient>)
    const writer = yield* (Effect.service(DurableWriter.DurableWriter).pipe(
      Effect.provide(context as never)
    ) as Effect.Effect<DurableWriter.Service>)
    return { sql, write: writer.write }
  })

/**
 * The in-memory path used by every other suite. `:memory:` is private to a
 * connection, so both handles are the same pair and serialization comes
 * from the client's in-process transaction mutex rather than the database —
 * a weaker mechanism that must still satisfy the same contract.
 */
const memoryHarness: Harness = {
  label: "TestDatabase, one shared in-memory connection",
  realDriver: false,
  crossConnection: false,
  run: (body) =>
    Effect.scoped(Effect.gen(function*() {
      const side = yield* connect(TestDatabase.layer)
      return yield* body({ a: side, b: side })
    })) as Effect.Effect<never>
}

describeContract(memoryHarness)
