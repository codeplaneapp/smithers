/**
 * A delegation node's predicted (or measured) resource envelope. Plan nodes
 * forecast one per child; exec rows report what actually happened. All
 * dimensions are optional — accuracy is judged only on dimensions present on
 * both sides.
 */
export type DelegationEstimate = {
  /** Total tokens (input + output). */
  tokens?: number;
  /** Dollar cost. */
  costUsd?: number;
  /** Wall-clock minutes. */
  minutes?: number;
};

/**
 * The shape `estimateAccuracyScorer` reads plan forecasts from: a dcPlan-like
 * row whose `children[].estimate` carries the per-child prediction. Replans
 * re-forecast, so later rows supersede earlier ones for the same child.
 * `subtreeEstimate` is a derived rollup and is not scored directly.
 */
export type DelegationPlanRowLike = {
  logicalId?: string;
  children?: {
    logicalId?: string;
    id?: string;
    estimate?: DelegationEstimate;
  }[];
  subtreeEstimate?: DelegationEstimate;
  [key: string]: unknown;
};

/** A dcExec-like row carrying the measured actuals for one node. */
export type DelegationExecRowLike = {
  logicalId?: string;
  id?: string;
  actual?: DelegationEstimate;
  [key: string]: unknown;
};

/**
 * The payload `estimateAccuracyScorer` accepts in the scored output or
 * context: plan rows under `plan` (or `plans`) and exec rows under `exec`
 * (or `execs`).
 */
export type DelegationEstimatePayload = {
  plan?: DelegationPlanRowLike[];
  plans?: DelegationPlanRowLike[];
  exec?: DelegationExecRowLike[];
  execs?: DelegationExecRowLike[];
  [key: string]: unknown;
};
