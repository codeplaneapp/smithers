import { Database as BunSqliteDatabase } from "bun:sqlite"
import { Effect, Layer, ManagedRuntime } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { Database } from "@flows/database"
import { Migrations } from "@flows/journal"
import { layerBunSqliteV4Client } from "./v4client.js"

/**
 * Create an isolated effect-4 ManagedRuntime hosting the vendored flows
 * durability stack over a SHARED bun:sqlite handle.
 *
 * The boundary contract: callers pass and receive plain JSON values only.
 * No Effect value, Layer, Context tag, or Schema ever crosses this line.
 *
 * @param {{
 *   sqlite: BunSqliteDatabase,
 *   runMigrations?: boolean
 * }} options
 */
export const createFlowsBoundary = async ({ sqlite, runMigrations = true }) => {
  if (!(sqlite instanceof BunSqliteDatabase)) {
    throw new TypeError("createFlowsBoundary requires a bun:sqlite Database handle")
  }
  const sqlLayer = layerBunSqliteV4Client(sqlite)
  const databaseLayer = Layer.effect(
    Database.Database,
    Effect.map(Effect.service(SqlClient.SqlClient), (sql) => Database.make(sql))
  ).pipe(Layer.provide(sqlLayer))
  const runtime = ManagedRuntime.make(databaseLayer)
  if (runMigrations) {
    await runtime.runPromise(Migrations.run)
  }
  return {
    sqlite,
    runtime,
    /** Run a flows effect requiring Database, returning a plain JSON value. */
    run: (effect) => runtime.runPromise(effect),
    dispose: () => runtime.dispose()
  }
}

export { layerBunSqliteV4Client, makeBunSqliteV4ClientEffect } from "./v4client.js"
