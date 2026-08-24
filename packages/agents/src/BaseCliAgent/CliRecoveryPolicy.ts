/**
 * Facts the recovery orchestrator observed about a failed attempt, handed to
 * the policy's classifier hook.
 */
export type CliRecoveryAttemptInfo = {
  /** 0-based attempt index that just failed. */
  attempt: number;
  /** The provider/CLI error the attempt failed with. */
  error: unknown;
  /** Bounded tail of the attempt's captured stderr. */
  stderrTail: string;
  /** Bounded tail of the attempt's captured stdout. */
  stdoutTail: string;
  /**
   * Whether the attempt emitted substantive model/tool/file activity
   * (assistant messages, command executions, file changes, tool calls)
   * before failing. Fresh retries are only safe before this point.
   */
  hadSubstantiveActivity: boolean;
  /**
   * The resume/session id the CLI emitted during this attempt, when any
   * (from started/completed events).
   */
  resumeSession?: string;
  /** Milliseconds since the recovery window started. */
  elapsedMs: number;
  /** Milliseconds left in the combined retry window, when bounded. */
  remainingMs?: number;
};

export type CliRecoveryClassification = {
  /**
   * `retry-fresh`: discard the failed attempt and start a brand-new
   * invocation. Only safe before substantive activity.
   * `resume-session`: continue the exact emitted CLI session without
   * replaying callbacks or workspace-changing work.
   * `terminal`: do not retry; surface the provider error.
   */
  kind: "retry-fresh" | "resume-session" | "terminal";
  /** Optional human-readable reason recorded in logs. */
  reason?: string;
  /** Optional provider-supplied delay before the next attempt. */
  retryAfterMs?: number;
};

/**
 * Typed provider retry/recovery policy for CLI agents. Designed for reuse
 * across adapters (CodexAgent, and any other BaseCliAgent subclass).
 */
export type CliRecoveryPolicy = {
  /**
   * Classify a failed attempt. Return undefined (or kind "terminal") to
   * surface the error without retrying.
   */
  classifyError: (info: CliRecoveryAttemptInfo) => CliRecoveryClassification | undefined;
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /**
   * Bound on the whole recovery window in milliseconds. Combined with the
   * caller's total timeout: the effective window is the smaller of the two,
   * measured from the start of the first attempt.
   */
  maxElapsedMs?: number;
  /**
   * Delay before the next attempt, as a function of the failed attempt
   * index. Default: 1s doubling per attempt, capped at 30s. Capped by the
   * remaining window and overridden by a classification's retryAfterMs.
   */
  backoffMs?: (attempt: number) => number;
  /**
   * Validate the resume/session id captured from CLI events before a
   * resume-session retry uses it. When this rejects (or no id was emitted),
   * the error surfaces instead of resuming an unverifiable session.
   */
  validateResumeSession?: (sessionId: string) => boolean;
  /**
   * Cap on quarantined callback output (events plus stdout/stderr text) per
   * attempt, in bytes. Failed-attempt callbacks are buffered up to this cap
   * and released only if the attempt turns out terminal. Default 1 MiB.
   */
  maxBufferedBytes?: number;
};
