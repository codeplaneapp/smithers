/**
 * Serialized, retryable write boundary for the durable flows stores.
 *
 * Governing persistence designs: `docs/pages/api/database.md` and
 * `docs/pages/concepts/journal.md`.
 *
 * The SQL client is Effect's own `SqlClient` service and is consumed
 * directly for queries; this module adds only the write policy the durable
 * stores share, plus the dialect-neutral error vocabulary. Domain schema and
 * operations remain in `@smthrs/journal`.
 *
 * @since 0.1.0
 */
import { Cause, Context, Effect, Layer, Option, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import * as WriteRetry from "./internal/WriteRetry.ts"

/**
 * Configuration for durable write retries.
 *
 * @category models
 * @since 1.0.0
 */
export type WriteRetryOptions = WriteRetry.WriteRetryOptions

/**
 * Stable categories exposed for database failures.
 *
 * @category models
 * @since 0.1.0
 */
export const DatabaseErrorCode = Schema.Literals(["busy", "constraint", "io", "unsupported", "unknown"])

/**
 * Stable database failure code.
 *
 * @category models
 * @since 0.1.0
 */
export type DatabaseErrorCode = typeof DatabaseErrorCode.Type

/**
 * A normalized database error suitable for consumers outside a driver.
 *
 * @category errors
 * @since 0.1.0
 */
export class DatabaseError extends Schema.TaggedError<DatabaseError>()("@smthrs/database/DatabaseError", {
  code: DatabaseErrorCode,
  cause: Schema.optional(Schema.Defect())
}) {}

/**
 * Runtime shape of the durable writer.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly write: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | DatabaseError, R>
}

/**
 * The write boundary shared by the durable stores, deliberately free of
 * journal or Host knowledge. Queries go through Effect's `SqlClient`
 * directly; only writes come here.
 *
 * **The `write` contract.** `write` runs its effect inside one transaction
 * with transaction-scoped retries, and implementations MUST guarantee that
 * write transactions are mutually serialized: two concurrent `write`
 * transactions may not both commit results computed from snapshots that
 * exclude each other's writes. Consumers depend on this for correctness,
 * not just isolation hygiene — the engine store's cycle detector inserts an
 * edge and walks the ancestor graph inside one `write`, and its safety
 * argument ("of two edges that jointly close a cycle, exactly the later
 * one fails") holds only under serialized writers. SQLite satisfies the
 * contract with its single-writer transaction lock; a PostgreSQL-backed
 * implementation must run write transactions at `SERIALIZABLE` (and retry
 * `40001`) — plain READ COMMITTED does not satisfy this contract.
 *
 * **Nesting.** A `write` inside the client's open transaction joins it as a
 * savepoint and does not retry: a transient conflict dooms the enclosing
 * transaction's snapshot, so replaying the savepoint alone can never resolve
 * it. Only the outermost `write` retries, replaying the whole transaction
 * body verbatim against the committed state. Its retry classification
 * follows `cause` chains, so a transient failure keeps replaying the
 * outermost transaction even after a nested store has wrapped it in a domain
 * error that preserves `cause`.
 *
 * @category services
 * @since 0.1.0
 */
export class DurableWriter extends Context.Service<DurableWriter, Service>()("@smthrs/database/DurableWriter") {}

/**
 * Converts an Effect SQL error into the package's stable error vocabulary.
 *
 * The category comes from `WriteRetry.classifySqlError`, the same call the
 * retry decision reads, so the code a caller is told and the decision to replay
 * cannot disagree about one error.
 *
 * @category converting
 * @since 0.1.0
 */
export const fromSqlError = (error: SqlError.SqlError): DatabaseError =>
  new DatabaseError({ code: WriteRetry.classifySqlError(error), cause: error })

const normalizeSqlErrors = <E>(
  cause: Cause.Cause<E | SqlError.SqlError>
): Cause.Cause<E | DatabaseError> =>
  Cause.map(
    cause,
    (error) => SqlError.isSqlError(error) ? fromSqlError(error) : error
  ) as Cause.Cause<E | DatabaseError>

// Only a driver's own data property counts: an inherited field or accessor is
// not a result the statement returned. Safe bigint counts are exact and occur
// when Effect SQL's SafeIntegers service is enabled; an out-of-range bigint or
// double cannot be represented without changing the count.
const rowCountOf = (raw: unknown, field: string): number | undefined => {
  if (typeof raw !== "object" || raw === null) {
    return undefined
  }
  const descriptor = Object.getOwnPropertyDescriptor(raw, field)
  if (descriptor === undefined || !("value" in descriptor)) {
    return undefined
  }
  const count = descriptor.value
  if (typeof count === "number") {
    return Number.isSafeInteger(count) && count >= 0 ? count : undefined
  }
  if (typeof count === "bigint") {
    return count >= 0n && count <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(count) : undefined
  }
  return undefined
}

const rawShape = (raw: unknown) => ({
  type: Array.isArray(raw) ? "array" : typeof raw,
  keys: typeof raw === "object" && raw !== null ? Object.keys(raw).slice(0, 8) : [],
  length: Array.isArray(raw) ? raw.length : undefined
})

/**
 * Reads how many rows a write statement affected from a driver's raw result.
 *
 * `SqlClient`'s `.raw` yields the driver's native result object, whose
 * affected-row field is dialect-specific: SQLite drivers (bun:sqlite,
 * better-sqlite3) report `changes`, node-postgres reports `rowCount`. A
 * consumer that casts to one shape silently reads `undefined` on the other
 * backend, turning a successful compare-and-swap delete into a reported
 * no-op. Reading it here keeps the whole vocabulary dialect-agnostic, as
 * `fromSqlError` already does for failure codes (issue #134).
 *
 * @category accessors
 * @since 0.1.0
 */
export const affectedRows = (raw: unknown): Effect.Effect<number, DatabaseError> =>
  Effect.suspend(() => {
    try {
      const count = rowCountOf(raw, "changes") ?? rowCountOf(raw, "rowCount")
      return count === undefined
        ? Effect.fail(new DatabaseError({ code: "unsupported", cause: rawShape(raw) }))
        : Effect.succeed(count)
    } catch {
      return Effect.fail(
        new DatabaseError({
          code: "unsupported",
          cause: { type: typeof raw, keys: [] }
        })
      )
    }
  })

/**
 * Builds the durable writer around an existing SQL client.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (sql: SqlClient.SqlClient, options?: WriteRetryOptions | undefined): Service =>
  DurableWriter.of({
    write: Effect.fn("DurableWriter.write")(<A, E, R>(
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<A, E | DatabaseError, R> =>
      Effect.flatMap(
        Effect.serviceOption(sql.transactionService),
        (enclosing) =>
          Effect.annotateCurrentSpan({ nested: Option.isSome(enclosing) }).pipe(
            Effect.andThen(
              (Option.isSome(enclosing)
                // Inside the client's transaction this write is a savepoint, and a
                // transient conflict dooms the enclosing transaction's snapshot:
                // replaying the savepoint alone can never resolve it, so the retry
                // belongs to the outermost write only.
                ? sql.withTransaction(effect)
                : WriteRetry.withWriteRetry(sql.withTransaction(effect), options)).pipe(
                  Effect.catchCause((cause) => Effect.failCause(normalizeSqlErrors(cause)))
                )
            )
          )
      )
    )
  })

/**
 * Provides the durable writer over the context's SQL client.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options?: WriteRetryOptions | undefined
): Layer.Layer<DurableWriter, never, SqlClient.SqlClient> =>
  Layer.effect(
    DurableWriter,
    Effect.map(Effect.service(SqlClient.SqlClient), (sql) => make(sql, options))
  )

/**
 * Builds a writer stub whose writes fail with `unsupported`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (): Service =>
  DurableWriter.of({
    write: Effect.fn("DurableWriter.write")(() => Effect.fail(new DatabaseError({ code: "unsupported" })))
  })

/**
 * Provides the unsupported writer stub.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<DurableWriter> = Layer.succeed(DurableWriter)(makeNoop())
