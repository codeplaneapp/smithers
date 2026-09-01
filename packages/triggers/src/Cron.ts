/**
 * Typed wrappers around Effect Cron.
 *
 * Effect's field parser only range-checks each field, so an expression like
 * `0 0 30 2 *` parses and then never matches a calendar date. Its occurrence
 * search answers that by exhausting its bound and throwing, which inside
 * `Effect.gen` is a defect rather than a typed failure: the fiber that owns the
 * search dies instead of reporting. Every search here is wrapped so the
 * exhausted bound arrives as `unsatisfiable_cron`, and {@link parse} probes for
 * one occurrence so an unsatisfiable expression is refused where it is
 * declared rather than at the tick that would have fired it.
 *
 * A satisfiable expression carries the opposite hazard: `* * * * *` across a
 * year is 525,600 occurrences, and materializing them costs seconds and
 * hundreds of megabytes. {@link occurrencesBetween} therefore always searches
 * under a finite cap and reports when an unstated limit would exceed
 * {@link maxOccurrences}.
 *
 * @since 0.1.0
 */
import * as Clock from "effect/Clock"
import * as EffectCron from "effect/Cron"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { TriggerError } from "./TriggerError.ts"

/**
 * A parsed cron expression, kept beside the text it came from so the
 * declaration can be round-tripped.
 *
 * @category models
 * @since 0.1.0
 */
export interface Cron {
  readonly expression: string
  readonly timezone?: string | undefined
  readonly value: EffectCron.Cron
}

const exhausted = (cron: Cron, search: string, cause: unknown): TriggerError =>
  new TriggerError({
    code: "unsatisfiable_cron",
    message: `cron expression '${cron.expression}' has no ${search} occurrence`,
    cause
  })

const attempt = <A>(cron: Cron, search: string, find: () => A): Effect.Effect<A, TriggerError> =>
  Effect.try({ try: find, catch: (cause) => exhausted(cron, search, cause) })

/**
 * The first occurrence strictly after `from`.
 *
 * @category getters
 * @since 0.1.0
 */
export const next = (cron: Cron, from: Date): Effect.Effect<Date, TriggerError> =>
  attempt(cron, "next", () => EffectCron.next(cron.value, from))

/**
 * Returns the latest occurrence at or before `at`.
 *
 * @category getters
 * @since 0.1.0
 */
export const previousAtOrBefore = (cron: Cron, at: Date): Effect.Effect<Date, TriggerError> => {
  if (EffectCron.match(cron.value, at)) {
    const occurrence = new Date(at)
    occurrence.setMilliseconds(0)
    return Effect.succeed(occurrence)
  }
  return attempt(cron, "previous", () => EffectCron.prev(cron.value, at))
}

/**
 * The greatest number of occurrences one search returns when its caller states
 * no limit of its own.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxOccurrences = 1000

/**
 * The occurrences in `(from, to]`, in order.
 *
 * A stated `limit` caps the result silently and must be a non-negative safe
 * integer. With no stated limit, the search fails with
 * `catch_up_bound_exceeded` when the interval holds more than
 * {@link maxOccurrences}. A caller with its own bound can pass one more than
 * that bound and compare the length, the way `CatchUp.occurrences` does.
 *
 * @category sequencing
 * @since 0.1.0
 */
export const occurrencesBetween = (
  cron: Cron,
  from: Date,
  to: Date,
  limit?: number | undefined
): Effect.Effect<ReadonlyArray<Date>, TriggerError> => {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    return Effect.fail(
      new TriggerError({
        code: "invalid_options",
        message: `occurrence limit must be a non-negative safe integer, received ${limit}`,
        path: "limit"
      })
    )
  }
  const searchLimit = limit ?? maxOccurrences + 1
  if (searchLimit === 0) return Effect.succeed([])
  const search = attempt(cron, "interval", () => {
    const occurrences: Array<Date> = []
    for (const occurrence of EffectCron.sequence(cron.value, from)) {
      if (occurrence.getTime() > to.getTime()) break
      if (occurrences.length >= searchLimit) break
      occurrences.push(occurrence)
    }
    return occurrences
  })
  if (limit !== undefined) return search
  return search.pipe(
    Effect.flatMap((occurrences) =>
      occurrences.length > maxOccurrences
        ? Effect.fail(
          new TriggerError({
            code: "catch_up_bound_exceeded",
            message: `interval contains more than ${maxOccurrences} occurrences; maxOccurrences is ${maxOccurrences}`
          })
        )
        : Effect.succeed(occurrences)
    )
  )
}

/**
 * Parses a cron expression in an optional timezone, reporting a malformed one
 * as `invalid_cron` and one the calendar never satisfies as
 * `unsatisfiable_cron`.
 *
 * The satisfiability probe searches forward from the current instant, which is
 * the same search every tick performs, so an expression that survives parsing
 * is one the scheduler can keep answering.
 *
 * @category constructors
 * @since 0.1.0
 */
export const parse = (expression: string, timezone?: string): Effect.Effect<Cron, TriggerError> =>
  Effect.gen(function*() {
    const parsed = EffectCron.parse(expression, timezone)
    if (Result.isFailure(parsed)) {
      return yield* Effect.fail(
        new TriggerError({ code: "invalid_cron", message: parsed.failure.message, cause: parsed.failure })
      )
    }
    const cron: Cron = {
      expression,
      ...(timezone === undefined ? {} : { timezone }),
      value: parsed.success
    }
    const now = yield* Clock.currentTimeMillis
    yield* next(cron, new Date(now))
    return cron
  })
