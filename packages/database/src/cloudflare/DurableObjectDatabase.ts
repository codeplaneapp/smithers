/**
 * Cloudflare Durable Object SQLite driver layer.
 *
 * Backend pattern: `@effect/sql-sqlite-node/SqliteClient` for the connection
 * shape and `@effect/sql-sqlite-do/SqliteClient` for the platform specifics.
 * The Node counterpart in this package is `src/node/NodeDatabase.ts`.
 *
 * Like that module this layer provides only the SQL client. The write policy
 * lives in `DurableWriter.layer`, composed on top, so a Durable Object gets
 * the same retry classification and the same serialization contract every
 * other backend gets.
 *
 * Three platform facts shape the implementation:
 *
 * - `ctx.storage.sql.exec` is synchronous. The whole connection is built out
 *   of `Effect.try`, with no promise and no prepared-statement cache: the
 *   statement runs on the calling thread and the cursor iterates an in-memory
 *   result.
 * - Durable Object SQLite refuses transaction-control statements through
 *   `exec`. `BEGIN`, `COMMIT`, and `ROLLBACK` belong to the platform, so the
 *   outermost transaction is `ctx.storage.transaction` rather than SQL, and
 *   `SqlClient.makeWithTransaction` — which assumes it can open and close a
 *   transaction with two separate statements — cannot be reused.
 * - `ctx.storage.transactionSync` is not usable here despite being the API a
 *   Durable Object normally reaches for. It commits when its closure
 *   *returns*, so it can only wrap work that finishes synchronously, and a
 *   `DurableWriter.write` body is an arbitrary `Effect` that may suspend.
 *   `ctx.storage.transaction` takes an async closure and is the only
 *   primitive that spans a suspension.
 *
 * One Durable Object owns one SQLite database and runs on one thread, so a
 * single connection is correct by construction. Mutual serialization of write
 * transactions — which `DurableWriter.write` states normatively and the engine
 * store's cycle detector depends on — comes from the connection semaphore
 * rather than from a database-level lock, the same mechanism the in-memory
 * `TestDatabase` harness relies on.
 *
 * @since 0.1.0
 */
import { Context, Effect, Exit, Layer, Semaphore, Stream } from "effect"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as SqlConnection from "effect/unstable/sql/SqlConnection"
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError"
import * as Statement from "effect/unstable/sql/Statement"
import type {
  DurableObjectStorageLike,
  SqlStorageCursorLike,
  SqlStorageLike,
  SqlStorageValue
} from "./SqlStorageLike.ts"

/**
 * Configuration for a Durable Object SQLite connection.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface DurableObjectDatabaseOptions {
  /** The Durable Object's storage handle, `ctx.storage`. */
  readonly storage: DurableObjectStorageLike
  /** Rewrites column names on the way out, as the other drivers' configs do. */
  readonly transformResultNames?: ((name: string) => string) | undefined
  /** Rewrites identifiers on the way in. */
  readonly transformQueryNames?: ((name: string) => string) | undefined
}

/** Names the transaction connection this client stores in the context. */
const DurableObjectTransaction = Context.Service<
  SqlClient.TransactionConnection,
  SqlClient.TransactionConnection.Service
>("@smthrs/database/cloudflare/DurableObjectDatabase/Transaction")

/**
 * Recovers the SQLite extended code from a failure's message.
 *
 * Durable Object SQLite reports a failure as a plain `Error` carrying SQLite's
 * own text and nothing else — no `code`, no `errno` — and
 * `classifySqliteError` reads only those two fields. Left alone, every
 * constraint violation would arrive as `UnknownError`, and
 * `DurableWriter.fromSqlError` decides `constraint` from the reason tag: the
 * stores would stop seeing the first-writer-wins signal they branch on and
 * would treat a lost insert race as a hard failure. `@effect/sql-sqlite-node`
 * carries an equivalent shim for the same reason, copying `errcode` onto
 * `errno` because `node:sqlite` names the field differently.
 *
 * Only the constraint family is recovered here. Busy, locked, and I/O
 * failures need no code: `DurableWriter.fromSqlError` and
 * `WriteRetry.isRetryableWriteError` already match those on the message text
 * as they walk the cause chain, because PGlite reports them the same way.
 */
const codeFromMessage = (message: string): string | undefined =>
  message.includes("UNIQUE constraint failed")
    ? "SQLITE_CONSTRAINT_UNIQUE"
    : message.includes("constraint failed")
    ? "SQLITE_CONSTRAINT"
    : undefined

const failure = (cause: unknown, message: string, operation: string): SqlError => {
  const reason = classifySqliteError(cause, { message, operation })
  // The message is consulted only where the cause carried no usable code, so
  // a platform that does report one keeps its own, more specific answer.
  if (reason._tag !== "UnknownError") {
    return new SqlError({ reason })
  }
  const text = String(cause)
  const code = codeFromMessage(text)
  return new SqlError({
    reason: code === undefined
      ? reason
      : classifySqliteError({ code, message: text, cause }, { message, operation })
  })
}

const executeFailure = (cause: unknown): SqlError => failure(cause, "Failed to execute statement", "execute")

/** A blob arrives as `ArrayBuffer`; `node:sqlite` hands back `Uint8Array`. */
const normalize = (value: SqlStorageValue): unknown => value instanceof ArrayBuffer ? new Uint8Array(value) : value

/**
 * Rows are read positionally and rebuilt against `columnNames` rather than
 * taken from the object cursor, so a query selecting two columns of the same
 * name yields both rather than silently keeping the last.
 */
function* rowIterator(
  sql: SqlStorageLike,
  statement: string,
  params: ReadonlyArray<unknown>
): Generator<Record<string, unknown>> {
  const cursor = sql.exec(statement, ...params)
  const columns = cursor.columnNames
  for (const values of cursor.raw()) {
    const row: Record<string, unknown> = {}
    for (let index = 0; index < columns.length; index++) {
      row[columns[index]!] = normalize(values[index]!)
    }
    yield row
  }
}

const valuesOf = (cursor: SqlStorageCursorLike): Array<Array<unknown>> =>
  Array.from(cursor.raw(), (values) => values.map(normalize))

/**
 * Reads how many rows the statement that just ran modified.
 *
 * SQLite's own `changes()` is used rather than the cursor's `rowsWritten`.
 * `rowsWritten` is a billing counter — it also counts the index rows a write
 * touches — so on any indexed table it reports more than the statement
 * affected, and `DurableWriter.affectedRows` feeds a compare-and-swap
 * decision that must be the exact row count.
 */
const changesOf = (sql: SqlStorageLike): number => {
  // `SELECT changes()` is a scalar select, so it yields exactly one row of one
  // column; reading it positionally keeps that a straight-line assertion
  // rather than a branch with an unreachable fallback.
  const [row] = Array.from(sql.exec("SELECT changes()").raw())
  return row![0] as number
}

const makeConnection = (sql: SqlStorageLike): SqlConnection.Connection => {
  const run = (
    statement: string,
    params: ReadonlyArray<unknown>
  ): Effect.Effect<Array<Record<string, unknown>>, SqlError> =>
    Effect.try({
      try: () => Array.from(rowIterator(sql, statement, params)),
      catch: executeFailure
    })

  /**
   * `.raw` is the affected-row seam. A statement with result columns yields
   * its rows, exactly as the `node:sqlite` driver does; a write yields the
   * `{ changes }` shape `DurableWriter.affectedRows` reads.
   */
  const runRaw = (statement: string, params: ReadonlyArray<unknown>): Effect.Effect<unknown, SqlError> =>
    Effect.try({
      try: () => {
        const cursor = sql.exec(statement, ...params)
        const columns = cursor.columnNames
        if (columns.length > 0) {
          return Array.from(rowIterator(sql, statement, params))
        }
        // Drain the cursor so the statement has finished before `changes()`.
        valuesOf(cursor)
        return { changes: changesOf(sql) }
      },
      catch: executeFailure
    })

  const runValues = (
    statement: string,
    params: ReadonlyArray<unknown>
  ): Effect.Effect<Array<Array<unknown>>, SqlError> =>
    Effect.try({
      try: () => valuesOf(sql.exec(statement, ...params)),
      catch: executeFailure
    })

  const execute: SqlConnection.Connection["execute"] = (statement, params, transformRows) =>
    transformRows ? Effect.map(run(statement, params), transformRows) : run(statement, params)

  return {
    execute,
    executeUnprepared: execute,
    executeRaw: runRaw,
    executeValues: runValues,
    executeValuesUnprepared: runValues,
    executeStream: (statement, params, transformRows) =>
      Stream.suspend(() => Stream.fromIteratorSucceed(rowIterator(sql, statement, params), 128)).pipe(
        transformRows ? Stream.mapArray((chunk) => transformRows(chunk) as any) : (self) => self
      )
  }
}

/**
 * Runs a nested write as a savepoint inside the enclosing transaction.
 *
 * `SAVEPOINT` and `ROLLBACK TO` are ordinary statements rather than
 * transaction control, so they go through `exec` like any other. Success
 * leaves the savepoint standing instead of releasing it, matching
 * `SqlClient.makeWithTransaction`: the commit at the end of the outermost
 * transaction releases every savepoint it holds.
 */
const withSavepoint = <A, E, R>(
  connection: SqlConnection.Connection,
  effect: Effect.Effect<A, E, R>,
  services: Context.Context<never>,
  id: number
): Effect.Effect<A, E | SqlError, R> => {
  const name = `effect_sql_${id}`
  return connection.executeUnprepared(`SAVEPOINT ${name}`, [], undefined).pipe(
    Effect.andThen(Effect.exit(
      Effect.provideContext(effect, Context.add(services, DurableObjectTransaction, [connection, id]))
    )),
    Effect.flatMap((exit) =>
      Exit.isSuccess(exit) ? exit : Effect.andThen(
        Effect.orDie(connection.executeUnprepared(`ROLLBACK TO ${name}`, [], undefined)),
        exit
      )
    )
  )
}

/**
 * Runs the outermost write inside a platform transaction.
 *
 * The body is resumed into the *calling* fiber rather than run through
 * `Effect.runPromise`, so it keeps the caller's services, spans, and
 * interruption. The closure's promise stays unresolved until the body
 * settles, which is what holds the platform transaction open across the
 * body's suspensions; the body's exit then rolls back or lets the platform
 * commit, and the effect completes only once that has happened.
 */
const withStorageTransaction = <A, E, R>(
  storage: DurableObjectStorageLike,
  connection: SqlConnection.Connection,
  effect: Effect.Effect<A, E, R>,
  services: Context.Context<never>
): Effect.Effect<A, E | SqlError, R> =>
  Effect.callback<A, E | SqlError, R>((resume) => {
    let interrupted = false
    const settled: Promise<void> = storage.transaction((transaction) =>
      new Promise<void>((resolve) => {
        if (interrupted) {
          transaction.rollback()
          return resolve()
        }
        resume(Effect.onExit(
          Effect.provideContext(effect, Context.add(services, DurableObjectTransaction, [connection, 0])),
          (exit) => {
            if (Exit.isFailure(exit)) {
              transaction.rollback()
            }
            resolve()
            // Surface the write only once the platform has settled it.
            return Effect.promise(() => settled)
          }
        ))
      })
    ).catch((cause) => resume(Effect.fail(failure(cause, "Failed transaction", "transaction"))))
    return Effect.suspend(() => {
      interrupted = true
      return Effect.promise(() => settled)
    })
  })

const makeWithTransaction = (
  storage: DurableObjectStorageLike,
  connection: SqlConnection.Connection,
  semaphore: Semaphore.Semaphore
): SqlClient.SqlClient["withTransaction"] =>
<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError, R> =>
  Effect.withFiber((fiber) => {
    const services = fiber.context
    const enclosing = Context.getOption(services, DurableObjectTransaction)
    return enclosing._tag === "Some"
      ? withSavepoint(connection, effect, services, enclosing.value[1] + 1)
      : semaphore.withPermits(1)(withStorageTransaction(storage, connection, effect, services))
  })

/**
 * Builds the Durable Object SQL client around a storage handle.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (
  options: DurableObjectDatabaseOptions
): Effect.Effect<SqlClient.SqlClient, never, Reactivity.Reactivity> =>
  Effect.gen(function*() {
    const connection = makeConnection(options.storage.sql)
    const semaphore = yield* Semaphore.make(1)
    const acquirer = semaphore.withPermits(1)(Effect.succeed(connection))
    const client = yield* SqlClient.make({
      acquirer,
      compiler: Statement.makeCompilerSqlite(options.transformQueryNames),
      transactionService: DurableObjectTransaction,
      spanAttributes: [["db.system.name", "sqlite"]],
      transformRows: options.transformResultNames
        ? Statement.defaultTransforms(options.transformResultNames).array
        : undefined
    })
    return Object.assign(client, {
      withTransaction: makeWithTransaction(options.storage, connection, semaphore)
    })
  })

/**
 * Provides the Durable Object SQLite client.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (options: DurableObjectDatabaseOptions): Layer.Layer<SqlClient.SqlClient> =>
  Layer.effect(SqlClient.SqlClient, make(options)).pipe(Layer.provide(Reactivity.layer))
