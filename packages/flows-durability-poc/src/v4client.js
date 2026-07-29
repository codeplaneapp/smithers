import { Context, Effect, Fiber, Layer, Scope, Stream } from "effect"
import * as Semaphore from "effect/Semaphore"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import * as Statement from "effect/unstable/sql/Statement"
import { layer as reactivityLayer } from "effect/unstable/reactivity/Reactivity"

const ATTR_DB_SYSTEM_NAME = "db.system.name"

const formatError = (operation, statement, cause) => {
  const compact = String(statement).replace(/\s+/g, " ").trim()
  const clipped = compact.length > 500 ? `${compact.slice(0, 497)}...` : compact
  const causeText = cause instanceof Error && cause.message ? cause.message : String(cause)
  return `Failed to execute SQLite ${operation}: ${causeText}; sql=${clipped}`
}

const makeSqlError = (operation, statement, cause) =>
  new SqlError.SqlError({
    reason: new SqlError.UnknownError({
      cause,
      message: formatError(operation, statement, cause),
      operation
    })
  })

const createConnection = (sqlite) => {
  const execute = (statement, params, transformRows) =>
    Effect.withFiber((fiber) => {
      const useSafeIntegers = Context.get(fiber.context, SqlClient.SafeIntegers)
      try {
        const query = sqlite.query(statement)
        query.safeIntegers(useSafeIntegers)
        const rows = query.all(...params) ?? []
        return Effect.succeed(transformRows ? transformRows(rows) : rows)
      } catch (cause) {
        return Effect.fail(makeSqlError("statement", statement, cause))
      }
    })
  return {
    execute: (statement, params, transformRows) => execute(statement, params, transformRows),
    executeRaw: (statement, params) => execute(statement, params, undefined),
    executeValues: (statement, params) =>
      Effect.withFiber((fiber) => {
        const useSafeIntegers = Context.get(fiber.context, SqlClient.SafeIntegers)
        try {
          const query = sqlite.query(statement)
          query.safeIntegers(useSafeIntegers)
          return Effect.succeed(query.values(...params) ?? [])
        } catch (cause) {
          return Effect.fail(makeSqlError("values statement", statement, cause))
        }
      }),
    executeUnprepared: (statement, params, transformRows) => execute(statement, params, transformRows),
    executeStream: (statement, params, transformRows) =>
      Stream.fromIterableEffect(execute(statement, params, transformRows))
  }
}

/**
 * Build an effect-4 SqlClient over an EXISTING bun:sqlite Database handle.
 *
 * The returned client shares the handle — and therefore the transaction domain —
 * with whatever else uses it (in smithers' case, SqlMessageStorage / drizzle).
 * Its `withTransaction` is bridge-aware: when the handle is already inside a
 * transaction begun by the other side (`sqlite.inTransaction === true`), the
 * effect joins the ambient transaction instead of issuing a nested BEGIN.
 *
 * @param {import("bun:sqlite").Database} sqlite
 */
export const makeBunSqliteV4ClientEffect = (sqlite) =>
  Effect.gen(function*() {
    const connection = createConnection(sqlite)
    const semaphore = yield* Semaphore.make(1)
    const acquirer = semaphore.withPermits(1)(Effect.succeed(connection))
    const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()
      const scope = Context.getUnsafe(fiber.context, Scope.Scope)
      return Effect.as(
        Effect.tap(
          restore(semaphore.take(1)),
          () => Scope.addFinalizer(scope, semaphore.release(1))
        ),
        connection
      )
    })
    const client = yield* SqlClient.make({
      acquirer,
      compiler: Statement.makeCompilerSqlite(undefined),
      transactionAcquirer,
      spanAttributes: [[ATTR_DB_SYSTEM_NAME, "sqlite"]],
      beginTransaction: "BEGIN IMMEDIATE"
    })
    const rawWithTransaction = client.withTransaction
    client.withTransaction = (effect) => sqlite.inTransaction ? effect : rawWithTransaction(effect)
    return client
  })

/**
 * Layer providing an effect-4 SqlClient + Reactivity over a shared bun:sqlite handle.
 * @param {import("bun:sqlite").Database} sqlite
 */
export const layerBunSqliteV4Client = (sqlite) =>
  Layer.provide(
    Layer.effect(SqlClient.SqlClient, makeBunSqliteV4ClientEffect(sqlite)),
    reactivityLayer
  )
