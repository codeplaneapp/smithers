/** Options for `planSolidityScorer`. */
export type PlanSolidityOptions = {
  /**
   * Penalty subtracted from 1.0 for each churn event that occurs after the
   * first `EXEC_STARTED` event. Plan-phase churn (before execution starts) is
   * free — that is the process working. Defaults:
   * `NODE_INVALIDATED` 0.10, `REDELEGATED` 0.08, `GATE_FAILED` 0.05,
   * `REPLAN_REQUESTED` 0.04.
   */
  penalties?: Partial<Record<"NODE_INVALIDATED" | "REDELEGATED" | "GATE_FAILED" | "REPLAN_REQUESTED", number>>;
};
