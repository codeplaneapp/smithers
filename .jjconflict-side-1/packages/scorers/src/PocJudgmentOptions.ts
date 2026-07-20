/**
 * How a planning node's probe judgment was classified by
 * `pocJudgmentScorer`.
 *
 * - `correctPositiveChanged` — flagged a risk, and the probe finding changed
 *   the plan (a replan or self-invalidation followed the finding).
 * - `correctPositiveConfirmed` — flagged a risk that proved real: either the
 *   probe finding was folded in and the node reaffirmed, or the flagged risk
 *   materialized in execution.
 * - `correctNegative` — flagged nothing, and nothing in its domain was later
 *   invalidated, redelegated, or gate-failed.
 * - `falsePositive` — flagged a risk, but the probe found nothing (or the
 *   finding had no downstream effect).
 * - `falseNegative` — flagged nothing, but its node was later invalidated,
 *   redelegated, or failed a gate. Punished hardest.
 */
export type PocJudgmentClassification =
  | "correctPositiveChanged"
  | "correctPositiveConfirmed"
  | "correctNegative"
  | "falsePositive"
  | "falseNegative";

/** Options for `pocJudgmentScorer`. */
export type PocJudgmentOptions = {
  /**
   * Per-classification score contribution in [0, 1]. Defaults reward
   * plan-changing findings hardest (1.0) and false negatives not at all (0).
   */
  values?: Partial<Record<PocJudgmentClassification, number>>;
  /**
   * Per-classification weight for the weighted mean over planning nodes.
   * Defaults weight `falseNegative` highest so missed risks dominate.
   */
  weights?: Partial<Record<PocJudgmentClassification, number>>;
};
