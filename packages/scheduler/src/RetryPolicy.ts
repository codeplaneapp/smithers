export type RetryBackoff = "fixed" | "linear" | "exponential";

/**
 * Author-facing retry gate (#1500). Return `false` (or set the flag itself to
 * `false`) to make a failure terminal immediately: no retry is scheduled and
 * the task goes to its terminal state with the full error payload.
 */
export type RetryPredicate = (error: unknown) => boolean;

export type RetryPolicy = {
  backoff?: RetryBackoff;
  initialDelayMs?: number;
  /**
   * Non-progress detection: after this many consecutive attempts fail with an
   * identical error signature, the task is marked `stalled` (a distinct
   * terminal state) instead of being retried again. Defaults to 3; set to 0
   * to disable stall detection for the task.
   */
  maxIdenticalFailures?: number;
  /**
   * Classify a failure before any retry is scheduled. `false` marks every
   * failure of the task terminal (equivalent to `retries={0}` but expressed
   * on the policy); a function is consulted per failure and a `false` return
   * makes that failure terminal.
   */
  retryable?: boolean | RetryPredicate;
};
