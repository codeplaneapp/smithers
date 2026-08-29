/**
 * Typed wrappers around Effect Cron.
 *
 * @since 0.1.0
 */
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

/**
 * Parses a cron expression in an optional timezone, reporting a malformed
 * one as `invalid_cron`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const parse = (expression: string, timezone?: string): Effect.Effect<Cron, TriggerError> => {
  const parsed = EffectCron.parse(expression, timezone)
  return Result.isFailure(parsed)
    ? Effect.fail(new TriggerError({ code: "invalid_cron", message: parsed.failure.message, cause: parsed.failure }))
    : Effect.succeed({ expression, ...(timezone === undefined ? {} : { timezone }), value: parsed.success })
}

/**
 * The first occurrence strictly after `from`.
 *
 * @category getters
 * @since 0.1.0
 */
export const next = (cron: Cron, from: Date): Date => EffectCron.next(cron.value, from)

/**
 * Returns the latest occurrence at or before `at`.
 *
 * @category getters
 * @since 0.1.0
 */
export const previousAtOrBefore = (cron: Cron, at: Date): Date => {
  if (EffectCron.match(cron.value, at)) {
    const occurrence = new Date(at)
    occurrence.setMilliseconds(0)
    return occurrence
  }
  return EffectCron.prev(cron.value, at)
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
): ReadonlyArray<Date> => {
  const occurrences: Array<Date> = []
  for (const occurrence of EffectCron.sequence(cron.value, from)) {
    if (occurrence.getTime() > to.getTime()) break
    occurrences.push(occurrence)
    if (occurrences.length >= limit) break
  }
  return occurrences
}
