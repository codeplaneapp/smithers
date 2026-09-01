/**
 * Write retry policy.
 *
 * Governing persistence design: `docs/pages/api/database.md`.
 *
 * Ported from the 0.x `withSqliteWriteRetryEffect`, deleted in Phase 1: retry
 * only structured transient failures, bound exponential delay, and use Effect
 * scheduling so interruption and `TestClock` remain native.
 *
 * Classification is dialect-blind by construction. `DurableWriter.make`
 * accepts any `SqlClient`, so a caller can already hand it a Postgres or
 * PGlite client; keying only off SQLite codes made the retry silently inert
 * there, and a serialization failure — the normal, expected outcome of two
 * drivers fencing one run — surfaced as a hard write error (issue #78). Both
 * vocabularies are recognised, and a code from the wrong dialect simply never
 * matches.
 *
 * @since 0.1.0
 */
import { Cause, Duration, Effect, Metric, Schedule } from "effect"
import * as SqlError from "effect/unstable/sql/SqlError"
import * as DatabaseMetrics from "../DatabaseMetrics.ts"

/**
 * Configuration for write retries.
 *
 * @category models
 * @since 0.1.0
 */
export interface WriteRetryOptions {
  /** Total attempts, including the initial write. */
  readonly maxAttempts?: number | undefined
  /** Initial exponential backoff delay in milliseconds. */
  readonly baseDelayMs?: number | undefined
  /** Upper bound for a single retry delay in milliseconds. */
  readonly maxDelayMs?: number | undefined
}

const defaultMaxAttempts = 10
const defaultBaseDelayMs = 50
const defaultMaxDelayMs = 10_000

const boundedPositiveInteger = (value: number | undefined, fallback: number): number => {
  const candidate = value ?? fallback
  return Number.isSafeInteger(candidate) && candidate >= 1 ? candidate : 1
}

const causeCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return undefined
  }
  const code = cause.code
  return typeof code === "string" ? code : undefined
}

/**
 * Postgres SQLSTATEs a write may legitimately be replayed on:
 * `40001` serialization_failure, `40P01` deadlock_detected, `55P03`
 * lock_not_available. `23505` (unique_violation) is deliberately absent — it
 * is the first-writer-wins signal the stores decide on, not a transient fault.
 */
const retryablePostgresStates = new Set(["40001", "40P01", "55P03"])

const isRetryableCode = (code: string | undefined): boolean =>
  code !== undefined &&
  (code.startsWith("SQLITE_BUSY") ||
    code.startsWith("SQLITE_LOCKED") ||
    retryablePostgresStates.has(code))

// PGlite runs Postgres in-process and does not always surface a SQLSTATE, so
// the canonical server texts are matched too.
const isRetryableMessage = (message: string): boolean =>
  message.includes("database is locked") ||
  message.includes("database is busy") ||
  message.includes("cannot rollback - no transaction is active") ||
  message.includes("could not serialize access") ||
  message.includes("deadlock detected")

const hasCause = (
  cause: unknown,
  match: (code: string | undefined, message: string) => boolean
): boolean => {
  const seen = new Set<unknown>()
  let current = cause
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current)
    if (SqlError.isSqlError(current)) {
      current = current.reason.cause
      continue
    }
    const message = "message" in current && typeof current.message === "string" ? current.message.toLowerCase() : ""
    if (match(causeCode(current), message)) {
      return true
    }
    current = "cause" in current ? current.cause : undefined
  }
  return false
}

/**
 * Returns whether a cause chain carries a recognized transient database
 * conflict.
 *
 * @category guards
 * @since 1.0.0
 */
export const isBusyCause = (cause: unknown): boolean =>
  hasCause(cause, (code, message) => isRetryableCode(code) || isRetryableMessage(message))

/**
 * Returns whether a cause chain carries a recognized SQLite I/O failure.
 *
 * @category guards
 * @since 1.0.0
 */
export const isIoCause = (cause: unknown): boolean =>
  hasCause(
    cause,
    (code, message) => code?.startsWith("SQLITE_IOERR") === true || message.includes("disk i/o error")
  )

/**
 * The stable category a structured SQL failure normalizes to.
 *
 * @category models
 * @since 1.0.0
 */
export type SqlFailureCode = "busy" | "constraint" | "io" | "unknown"

/**
 * Classifies a structured SQL error once, for both the retry decision and the
 * code `DurableWriter.DatabaseError` reports.
 *
 * One function rather than two predicates, because the two used to disagree on
 * a mixed cause chain: an `SQLITE_IOERR` whose own cause carried `SQLITE_BUSY`
 * was reported as `io` — the category the package documents as never replayed
 * — and retried anyway. Precedence is decided here, in one place, so a code and
 * a retry decision can no longer drift apart: a lock timeout is always busy, a
 * constraint violation is never transient, and an I/O failure outranks a busy
 * cause nested beneath it, because the write did reach the disk.
 *
 * @category classifying
 * @since 1.0.0
 */
export const classifySqlError = (error: SqlError.SqlError): SqlFailureCode =>
  error.reason._tag === "LockTimeoutError"
    ? "busy"
    : error.reason._tag === "ConstraintError" || error.reason._tag === "UniqueViolation"
    ? "constraint"
    : isIoCause(error.reason.cause)
    ? "io"
    : isBusyCause(error.reason.cause)
    ? "busy"
    : "unknown"

/**
 * Returns whether a failure represents a transient write conflict in either
 * the SQLite or the Postgres vocabulary. The failure may be
 * the structured SQL error itself or a domain error wrapping one — the walk
 * follows `cause` chains (and a `SqlError`'s reason cause) either way, so the
 * outermost `DurableWriter.write` still replays a transaction whose failing
 * savepoint a nested store already normalized into its own error type.
 * Constraint, syntax, and arbitrary application errors are deliberately never
 * retried, and neither is an I/O failure with a busy cause beneath it: the
 * classification {@link classifySqlError} makes is the whole decision.
 *
 * @category guards
 * @since 0.1.0
 */
export const isRetryableWriteError = (error: unknown): boolean => {
  const seen = new Set<unknown>()
  let current = error
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current)
    if (SqlError.isSqlError(current)) {
      return classifySqlError(current) === "busy"
    }
    current = "cause" in current ? current.cause : undefined
  }
  return false
}

/**
 * A defect is retryable on the same terms a typed failure is: a busy cause the
 * driver threw raw, and never an I/O failure that happens to carry one.
 *
 * rc.108 can throw its rollback failure as a raw defect, before a `SqlError`
 * exists to provide provenance, which is why the defect channel is read at all.
 * Typed failures never get that exception.
 */
const isRetryableDefect = (defect: unknown): boolean => isBusyCause(defect) && !isIoCause(defect)

interface ClassifiedCause<E> {
  readonly cause: Cause.Cause<E>
  readonly retryable: boolean
}

/**
 * Decides whether a cause is worth replaying, reading every reason it carries.
 *
 * `Cause.findError`/`findDefect` answer with the FIRST reason of a kind, so a
 * parallel cause that pairs a busy SQL failure with an application error was
 * retried or not depending on which half arrived first. A write that raced two
 * effects is exactly where that shape comes from, so the whole reason list is
 * scanned instead. Typed failures are scanned before defects so a cause that
 * carries both is classified with the provenance a `SqlError` gives.
 */
const classifyCause = <E>(cause: Cause.Cause<E>): ClassifiedCause<E> => {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason) && isRetryableWriteError(reason.error)) {
      return { cause, retryable: true }
    }
  }
  for (const reason of cause.reasons) {
    if (Cause.isDieReason(reason) && isRetryableDefect(reason.defect)) {
      return { cause, retryable: true }
    }
  }
  return { cause, retryable: false }
}

/**
 * Retries recognized transient write errors using exponential backoff and
 * jitter. Delays use Effect's Clock and therefore work with TestClock.
 *
 * @category combinators
 * @since 0.1.0
 */
export const withWriteRetry = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options?: WriteRetryOptions | undefined
): Effect.Effect<A, E, R> => {
  const maxAttempts = boundedPositiveInteger(options?.maxAttempts, defaultMaxAttempts)
  const baseDelayMs = boundedPositiveInteger(options?.baseDelayMs, defaultBaseDelayMs)
  const maxDelayMs = boundedPositiveInteger(options?.maxDelayMs, defaultMaxDelayMs)
  // Jitter runs before the cap so `maxDelayMs` bounds the delay that is
  // actually slept: capping first and jittering after lets a jitter draw
  // above 1 stretch a delay past the documented upper bound.
  const schedule = Schedule.exponential(Duration.millis(baseDelayMs)).pipe(
    Schedule.jittered,
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(Duration.millis(Math.min(maxDelayMs, Duration.toMillis(duration))))
    ),
    Schedule.upTo({ times: maxAttempts - 1 }),
    // The tap sits after `upTo`, so it fires once per step that actually
    // schedules a replay and never for the exhausted attempt that surfaces
    // the error instead.
    Schedule.tap(() => Metric.update(DatabaseMetrics.writeRetries, 1))
  )
  const retryableEffect = Effect.catchCause(effect, (cause) => Effect.fail(classifyCause(cause)))
  return Effect.retry(retryableEffect, { schedule, while: (classified) => classified.retryable }).pipe(
    Effect.catch((classified) => Effect.failCause(classified.cause))
  )
}
