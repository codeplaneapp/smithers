import { Effect, ScheduleDecision, ScheduleIntervals } from "effect";
/**
 * @param {import("effect").Schedule.Schedule<unknown>} schedule
 * @param {number} attempt
 * @returns {number}
 */
export function retryScheduleDelayMs(schedule, attempt) {
  // Bound the schedule walk: every supported backoff is monotonic and
  // capped, so past this many steps the delay cannot change — and a
  // non-finite attempt (Infinity) would otherwise loop forever.
  const MAX_SCHEDULE_STEPS = 10_000;
  const safeAttempt = Math.max(1, Math.floor(Math.min(attempt, MAX_SCHEDULE_STEPS)));
  let state = schedule.initial;
  let now = 0;
  let delayMs = 0;
  for (let index = 0; index < safeAttempt; index++) {
    const [nextState, , decision] = Effect.runSync(schedule.step(now, undefined, state));
    if (ScheduleDecision.isDone(decision)) {
      return 0;
    }
    const nextNow = ScheduleIntervals.start(decision.intervals);
    delayMs = Math.max(0, nextNow - now);
    state = nextState;
    now = nextNow;
  }
  return delayMs;
}
