export type SupervisorPollSummary = {
  staleCount: number;
  resumedCount: number;
  skippedCount: number;
  durationMs: number;
  /** Runs that passed every safety guard and would be resumed in dry-run mode. */
  wouldResumeRunIds: string[];
};
