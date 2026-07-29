import { Duration, Effect, Result, Schedule } from "effect";
/**
 * @param {import("effect").Schedule.Schedule<unknown, unknown>} schedule
 * @param {number} attempt
 * @returns {number}
 */
export function retryScheduleDelayMs(schedule, attempt) {
  // Bound the schedule walk: every supported backoff is monotonic and
  // capped, so past this many steps the delay cannot change — and a
  // non-finite attempt (Infinity) would otherwise loop forever.
  const MAX_SCHEDULE_STEPS = 10_000;
  const safeAttempt = Math.max(1, Math.floor(Math.min(attempt, MAX_SCHEDULE_STEPS)));
  const step = Effect.runSync(Schedule.toStep(schedule));
  let now = 0;
  let delayMs = 0;
  for (let index = 0; index < safeAttempt; index++) {
    const result = Effect.runSync(Effect.result(step(now, undefined)));
    if (Result.isFailure(result)) {
      return 0;
    }
    delayMs = Math.max(0, Duration.toMillis(result.success[1]));
    now += delayMs;
  }
  return delayMs;
}
