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
 * The occurrences in `(from, to]`, in order, capped at `limit`.
 *
 * @category sequencing
 * @since 0.1.0
 */
export const occurrencesBetween = (
  cron: Cron,
  from: Date,
  to: Date,
  limit = Number.POSITIVE_INFINITY
): Effect.Effect<ReadonlyArray<Date>, TriggerError> =>
  attempt(cron, "interval", () => {
    const occurrences: Array<Date> = []
    for (const occurrence of EffectCron.sequence(cron.value, from)) {
      if (occurrence.getTime() > to.getTime()) break
      occurrences.push(occurrence)
      if (occurrences.length >= limit) break
    }
    return occurrences
  })

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
