// @smithers-type-exports-begin
/** @typedef {import("./AggregateOptions.js").AggregateOptions} AggregateOptions */
/** @typedef {import("./types.js").AggregateScore} AggregateScore */
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./DelegationRunScoreOptions.js").DelegationRunResults} DelegationRunResults */
/** @typedef {import("./DelegationRunScoreOptions.js").DelegationRunScoreOptions} DelegationRunScoreOptions */
/** @typedef {import("./types.js").ScoreResult} ScoreResult */
// @smithers-type-exports-end

/**
 * Computes aggregate statistics for scorer results.
 *
 * Returns one row per scorer with count, mean, min, max, p50, and stddev.
 * Uses a simple SQL aggregation query plus in-memory p50 calculation,
 * since SQLite does not support PERCENTILE_CONT or correlated subqueries
 * in GROUP BY reliably.
 *
 * @param {SmithersDb} adapter
 * @param {AggregateOptions} [opts]
 * @returns {Promise<AggregateScore[]>}
 */
export async function aggregateScores(adapter, opts) {
    const conditions = [];
    const params = [];
    if (opts?.runId)
        addFilter(conditions, params, "run_id", opts.runId);
    if (opts?.nodeId)
        addFilter(conditions, params, "node_id", opts.nodeId);
    if (opts?.scorerId)
        addFilter(conditions, params, "scorer_id", opts.scorerId);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    // Step 1: Get aggregate stats via SQL
    const aggQuery = `
    SELECT
      scorer_id,
      scorer_name,
      COUNT(*) AS cnt,
      AVG(score) AS mean,
      MIN(score) AS min_score,
      MAX(score) AS max_score
    FROM _smithers_scorers
    ${where}
    GROUP BY scorer_id, scorer_name
    ORDER BY scorer_name
  `;
    const aggRows = (await adapter.rawQuery(aggQuery, params));
    if (aggRows.length === 0)
        return [];
    // Step 2: Get all scores to compute p50 and stddev per scorer in memory
    const scoresQuery = `
    SELECT scorer_id, score
    FROM _smithers_scorers
    ${where}
    ORDER BY scorer_id, score
  `;
    const allScores = (await adapter.rawQuery(scoresQuery, params));
    // Group scores by scorer_id
    const scoresByScorer = new Map();
    for (const row of allScores) {
        const id = row.scorer_id;
        if (!scoresByScorer.has(id))
            scoresByScorer.set(id, []);
        scoresByScorer.get(id).push(Number(row.score));
    }
    return aggRows.map((row) => {
        const scores = scoresByScorer.get(row.scorer_id) ?? [];
        const p50 = computeMedian(scores);
        const mean = Number(row.mean ?? 0);
        const stddev = computeStddev(scores, mean);
        return {
            scorerId: row.scorer_id,
            scorerName: row.scorer_name,
            count: Number(row.cnt),
            mean,
            min: Number(row.min_score ?? 0),
            max: Number(row.max_score ?? 0),
            p50,
            stddev,
        };
    });
}
/**
 * @param {number[]} sorted
 * @returns {number}
 */
function computeMedian(sorted) {
    if (sorted.length === 0)
        return 0;
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
}
/**
 * @param {number[]} values
 * @param {number} mean
 * @returns {number}
 */
function computeStddev(values, mean) {
    if (values.length <= 1)
        return 0;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
}
/**
 * @param {string[]} conditions
 * @param {string[]} params
 * @param {string} column
 * @param {string} value
 */
function addFilter(conditions, params, column, value) {
    conditions.push(`${column} = ?`);
    params.push(value);
}
/**
 * Combines named `ScoreResult`s into one weighted score.
 *
 * Components that are missing, `null` (e.g. sampled out or failed in
 * `runScorersBatch`), or skipped (`meta.skipped`) are excluded and the
 * remaining weights renormalize, so a not-applicable component never dilutes
 * the total. When every component is excluded the combined result is itself
 * skipped (score 1, `meta.skipped`), matching the built-in scorers' no-op
 * convention.
 *
 * @param {Record<string, ScoreResult | null | undefined>} results
 * @param {Record<string, number>} weights
 * @returns {ScoreResult}
 */
export function weightedScore(results, weights) {
    /** @type {Record<string, { weight: number; skipped: true } | { weight: number; appliedWeight: number; score: number; reason?: string }>} */
    const components = {};
    let total = 0;
    let weightSum = 0;
    for (const [key, weight] of Object.entries(weights)) {
        const result = results[key];
        if (!Number.isFinite(weight) || weight <= 0 || result == null || result.meta?.skipped === true) {
            components[key] = { weight, skipped: true };
            continue;
        }
        total += result.score * weight;
        weightSum += weight;
        components[key] = {
            weight,
            appliedWeight: weight,
            score: result.score,
            reason: result.reason,
        };
    }
    if (weightSum === 0) {
        return {
            score: 1,
            reason: "All components skipped or missing; skipping",
            meta: { skipped: true, components },
        };
    }
    // Record the renormalized share each scored component contributed.
    for (const component of Object.values(components)) {
        if ("appliedWeight" in component) {
            component.appliedWeight = component.weight / weightSum;
        }
    }
    const score = Math.max(0, Math.min(1, total / weightSum));
    const summary = Object.entries(components)
        .map(([key, component]) => "score" in component
        ? `${key} ${component.score.toFixed(2)}`
        : `${key} skipped`)
        .join(", ");
    return {
        score,
        reason: `Weighted total of ${summary}`,
        meta: { components },
    };
}
/** @type {Record<"pocJudgment" | "planSolidity" | "estimateAccuracy" | "tierFit" | "humanPoll", number>} */
const DELEGATION_RUN_WEIGHTS = {
    pocJudgment: 0.25,
    planSolidity: 0.25,
    estimateAccuracy: 0.15,
    tierFit: 0.15,
    humanPoll: 0.2,
};
/**
 * Combines the five delegation-chain scorer results into the run total shown
 * in the scores panel: `pocJudgmentScorer`, `planSolidityScorer`,
 * `estimateAccuracyScorer`, `tierFitScorer`, and `humanPollScorer`, weighted
 * 0.25 / 0.25 / 0.15 / 0.15 / 0.2 by default. Built on `weightedScore`, so
 * skipped or missing components (e.g. a poll the user never submitted) drop
 * out and the remaining weights renormalize.
 *
 * @param {DelegationRunResults} results
 * @param {DelegationRunScoreOptions} [opts]
 * @returns {ScoreResult}
 */
export function delegationRunScore(results, opts) {
    const weights = { ...DELEGATION_RUN_WEIGHTS, ...opts?.weights };
    return weightedScore(results, weights);
}
