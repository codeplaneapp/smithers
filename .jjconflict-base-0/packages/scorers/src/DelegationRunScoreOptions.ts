import type { ScoreResult } from "./types";

/** The component keys `delegationRunScore` combines. */
export type DelegationRunComponent =
  | "pocJudgment"
  | "planSolidity"
  | "estimateAccuracy"
  | "tierFit"
  | "humanPoll";

/**
 * The per-component results fed to `delegationRunScore`. A component may be
 * absent, `null` (e.g. sampled out or failed in `runScorersBatch`), or a
 * `ScoreResult` with `meta.skipped` — all three are excluded from the
 * weighted total and the remaining weights are renormalized.
 */
export type DelegationRunResults = Partial<
  Record<DelegationRunComponent, ScoreResult | null | undefined>
>;

/** Options for `delegationRunScore`. */
export type DelegationRunScoreOptions = {
  /**
   * Component weights. Defaults: pocJudgment 0.25, planSolidity 0.25,
   * estimateAccuracy 0.15, tierFit 0.15, humanPoll 0.2.
   */
  weights?: Partial<Record<DelegationRunComponent, number>>;
};
