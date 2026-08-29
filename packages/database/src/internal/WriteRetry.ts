/**
 * Write retry policy.
 *
 * Governing persistence design: `docs/specs/Concepts/Run Ownership.md`.
 *
 * Adapted from smithers `packages/db/src/withSqliteWriteRetryEffect.js`:
 * retry only structured transient failures, bound exponential delay, and use
 * Effect scheduling so interruption and `TestClock` remain native.
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
import { Cause, Duration, Effect, Metric, Result, Schedule } from "effect"
import * as SqlError from "effect/unstable/sql/SqlError"
import * as DatabaseMetrics from "../DatabaseMetrics.ts"

/**
 * Configuration for write retries.
 *
 * @category models
 * @since 0.1.0
 * @slop
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

/**
 * Returns whether a failure represents a transient write conflict in either
 * the SQLite or the Postgres vocabulary. The failure may be
 * the structured SQL error itself or a domain error wrapping one — the walk
 * follows `cause` chains (and a `SqlError`'s reason cause) either way, so the
 * outermost `DurableWriter.write` still replays a transaction whose failing
 * savepoint a nested store already normalized into its own error type.
 * Constraint, syntax, and arbitrary application errors are deliberately never
 * retried.
 *
 * @category guards
 * @since 0.1.0
 * @slop
 */
export const isRetryableWriteError = (error: unknown): boolean => {
  const seen = new Set<unknown>()
  let current = error
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current)
    if (SqlError.isSqlError(current)) {
      if (current.reason._tag === "LockTimeoutError") return true
      current = current.reason.cause
      continue
    }
    const message = "message" in current && typeof current.message === "string" ? current.message.toLowerCase() : ""
    if (isRetryableCode(causeCode(current)) || isRetryableMessage(message)) {
      return true
    }
    current = "cause" in current ? current.cause : undefined
  }
  return false
}

const retryableFromCause = <E>(cause: Cause.Cause<E>): E | undefined => {
  const failure = Result.getOrUndefined(Cause.findError(cause))
  if (isRetryableWriteError(failure)) {
    return failure
  }
  const defect = Result.getOrUndefined(Cause.findDefect(cause))
  return isRetryableWriteError(defect) ? defect as E : undefined
}

/**
 * Retries recognized transient write errors using exponential backoff and
 * jitter. Delays use Effect's Clock and therefore work with TestClock.
 *
 * @category combinators
 * @since 0.1.0
 * @slop
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
  const retryableEffect = Effect.catchCause(effect, (cause) => {
    const retryable = retryableFromCause(cause)
    return retryable === undefined ? Effect.failCause(cause) : Effect.fail(retryable)
  })
  return Effect.retry(retryableEffect, { schedule, while: isRetryableWriteError })
}
