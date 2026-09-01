/**
 * Pure catch-up policy decisions.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import type { Cron } from "./Cron.ts"
import * as CronSchedule from "./Cron.ts"
import type { CatchUp as Policy } from "./Trigger.ts"
import { TriggerError } from "./TriggerError.ts"

/**
 * The occurrences a trigger owes since it last fired, bounded by
 * `maxCatchUp` and by the policy: `skip` owes nothing, `last` owes only the
 * most recent, and `all` owes every missed tick.
 *
 * @category computation
 * @since 0.1.0
 */
export const occurrences = (
  policy: Policy,
  maxCatchUp: number,
  lastFiredAt: Date | undefined,
  now: Date,
  cron: Cron
): Effect.Effect<ReadonlyArray<Date>, TriggerError> => {
  if (lastFiredAt === undefined) return Effect.succeed([])
  if (policy === "none") return Effect.succeed([])
  if (!Number.isSafeInteger(maxCatchUp) || maxCatchUp < 0) {
    return Effect.fail(
      new TriggerError({
        code: "catch_up_bound_exceeded",
        message: "maxCatchUp must be a non-negative safe integer"
      })
    )
  }
  if (policy === "one") {
    return CronSchedule.previousAtOrBefore(cron, now).pipe(
      Effect.map((latest) => latest.getTime() <= lastFiredAt.getTime() ? [] : [latest])
    )
  }
  return CronSchedule.occurrencesBetween(cron, lastFiredAt, now, maxCatchUp + 1).pipe(
    Effect.flatMap((missed) =>
      missed.length > maxCatchUp
        ? Effect.fail(
          new TriggerError({
            code: "catch_up_bound_exceeded",
            message: `missed ${missed.length} occurrences; maxCatchUp is ${maxCatchUp}`
          })
        )
        : Effect.succeed(missed)
    )
  )
}
