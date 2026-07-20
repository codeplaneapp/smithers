/** A benchmark run as seen by the fleet supervisor (a projection of `smithers ps`). */
export type FleetRun = {
  runId: string;
  status: string;
  /**
   * Epoch ms at which this run's quota window resets, when it is parked on
   * `waiting-quota` with a known reset. Absent for credit-exhaustion parks
   * (no reset), which smithers deliberately leaves for a human.
   */
  quotaResetAtMs?: number;
};
