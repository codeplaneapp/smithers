export type SupervisorPollSummary = {
  staleCount: number;
  resumedCount: number;
  skippedCount: number;
  durationMs: number;
  /** Runs that passed every safety guard and would be resumed in dry-run mode. */
  wouldResumeRunIds: string[];
  /**
   * Runs the supervisor stopped auto-resuming during this poll because
   * `maxResumeAttempts` consecutive resumes died before the engine activated.
   * Each is marked failed with `AUTO_RESUME_GAVE_UP` and raises a durable alert.
   */
  gaveUpRunIds: string[];
};

/** Result of a supervisor loop that ran to completion (all scoped runs terminal). */
export type SupervisorLoopSummary = {
  /** Every run the loop gave up on, across all polls. */
  gaveUpRunIds: string[];
};
