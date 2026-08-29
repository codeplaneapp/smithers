/**
 * Serialized, retryable write boundary for the durable flows stores.
 *
 * Governing persistence designs:
 * `docs/specs/Concepts/Journal Queue.md` and
 * `docs/specs/Concepts/Run Ownership.md`.
 *
 * The SQL client is Effect's own `SqlClient` service and is consumed
 * directly for queries; this module adds only the write policy the durable
 * stores share, plus the dialect-neutral error vocabulary. Domain schema and
 * operations remain in `@smthrs/journal`.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import * as WriteRetry from "./internal/WriteRetry.ts"

/**
 * Stable categories exposed for database failures.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const DatabaseErrorCode = Schema.Literals(["busy", "constraint", "io", "unsupported", "unknown"])

/**
 * Stable database failure code.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type DatabaseErrorCode = typeof DatabaseErrorCode.Type

/**
 * A normalized database error suitable for consumers outside a driver.
 *
 * @category errors
 * @since 0.1.0
 * @slop
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
 * @slop
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
 * @slop
 */
export class DurableWriter extends Context.Service<DurableWriter, Service>()("@smthrs/database/DurableWriter") {}

const causeCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return undefined
  }
  const code = cause.code
  return typeof code === "string" ? code : undefined
}

// Postgres reports a lost write race as a SQLSTATE rather than a lock error,
// so it maps to the same stable `busy` category a SQLITE_BUSY does; a caller
// that branches on the code sees one vocabulary across dialects (issue #78).
const busyPostgresStates = new Set(["40001", "40P01", "55P03"])

const hasCause = (cause: unknown, match: (code: string | undefined, message: string) => boolean): boolean => {
  const seen = new Set<unknown>()
  let current = cause
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current)
    const message = "message" in current && typeof current.message === "string" ? current.message.toLowerCase() : ""
    if (match(causeCode(current), message)) {
      return true
    }
    current = "cause" in current ? current.cause : undefined
  }
  return false
}

const hasIoCause = (cause: unknown): boolean =>
  hasCause(cause, (code, message) => code?.startsWith("SQLITE_IOERR") === true || message.includes("disk i/o error"))

const hasBusyCause = (cause: unknown): boolean =>
  hasCause(
    cause,
    (code, message) =>
      (code !== undefined && busyPostgresStates.has(code)) ||
      message.includes("cannot rollback - no transaction is active") ||
      message.includes("could not serialize access") ||
      message.includes("deadlock detected")
  )

/**
 * Converts an Effect SQL error into the package's stable error vocabulary.
 *
 * @category converting
 * @since 0.1.0
 * @slop
 */
export const fromSqlError = (error: SqlError.SqlError): DatabaseError =>
  new DatabaseError({
    code: error.reason._tag === "LockTimeoutError" ?
      "busy" :
      error.reason._tag === "ConstraintError" || error.reason._tag === "UniqueViolation" ?
      "constraint" :
      hasIoCause(error.reason.cause)
      ? "io"
      : hasBusyCause(error.reason.cause)
      ? "busy"
      : "unknown",
    cause: error
  })

// Only a driver's own result field counts: an inherited `changes` comes from
// a prototype, not from the statement that ran. The count must also be a safe
// integer — above `Number.MAX_SAFE_INTEGER` the exact count is unreadable, so
// reporting the rounded double would silently misreport the write.
const rowCountOf = (raw: unknown, field: string): number | undefined => {
  if (typeof raw !== "object" || raw === null || !Object.hasOwn(raw, field)) {
    return undefined
  }
  const count = (raw as Record<string, unknown>)[field]
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : undefined
}

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
 * @slop
 */
export const affectedRows = (raw: unknown): Effect.Effect<number, DatabaseError> => {
  const count = rowCountOf(raw, "changes") ?? rowCountOf(raw, "rowCount")
  return count === undefined
    ? Effect.fail(new DatabaseError({ code: "unsupported", cause: raw }))
    : Effect.succeed(count)
}

/**
 * Builds the durable writer around an existing SQL client.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (sql: SqlClient.SqlClient, options?: WriteRetry.WriteRetryOptions | undefined): Service =>
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
                  Effect.catchIf(SqlError.isSqlError, (error) => Effect.fail(fromSqlError(error)))
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
 * @slop
 */
export const layer = (
  options?: WriteRetry.WriteRetryOptions | undefined
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
 * @slop
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
 * @slop
 */
export const layerNoop: Layer.Layer<DurableWriter> = Layer.succeed(DurableWriter)(makeNoop())
