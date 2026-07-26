import { Duration, Schedule } from "effect";
/** @typedef {import("./RetryPolicy.ts").RetryPolicy} RetryPolicy */
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;
/**
 * Convert a RetryPolicy to an Effect Schedule for use with Effect.retry.
 *
 * @param {RetryPolicy} policy
 * @returns {Schedule.Schedule<unknown>}
 */
export function retryPolicyToSchedule(policy) {
  const base = typeof policy.initialDelayMs === "number" ? Math.max(0, Math.floor(policy.initialDelayMs)) : 0;
  if (base <= 0) return Schedule.stop;
  const backoff = policy.backoff ?? "fixed";
  const capDelay = Schedule.modifyDelay((_out, delay) => Duration.min(delay, Duration.millis(MAX_RETRY_DELAY_MS)));
  switch (backoff) {
    case "linear":
      return capDelay(Schedule.linear(Duration.millis(base)));
    case "exponential":
      return capDelay(Schedule.exponential(Duration.millis(base)));
    default:
      // Unrecognized backoff values (e.g. from untyped JSON config) clamp
      // to the same "fixed" default as an absent backoff, rather than
      // returning undefined and crashing delay computation mid-run.
      return capDelay(Schedule.fixed(Duration.millis(base)));
  }
}
