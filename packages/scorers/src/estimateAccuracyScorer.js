import { createScorer } from "./createScorer.js";
/** @typedef {import("./DelegationEstimate.js").DelegationEstimate} DelegationEstimate */
/** @typedef {import("./DelegationEstimate.js").DelegationExecRowLike} DelegationExecRowLike */
/** @typedef {import("./DelegationEstimate.js").DelegationPlanRowLike} DelegationPlanRowLike */
/** @typedef {import("./types.js").Scorer} Scorer */

/** The estimate dimensions the scorer can compare. */
const DIMENSIONS = /** @type {const} */ (["tokens", "costUsd", "minutes"]);

/**
 * @param {unknown} candidate
 * @returns {{ plan: DelegationPlanRowLike[]; exec: DelegationExecRowLike[] } | null}
 */
function toEstimatePayload(candidate) {
    if (typeof candidate !== "object" || candidate === null)
        return null;
    const record = /** @type {Record<string, unknown>} */ (candidate);
    const plan = Array.isArray(record.plan)
        ? record.plan
        : Array.isArray(record.plans)
            ? record.plans
            : null;
    const exec = Array.isArray(record.exec)
        ? record.exec
        : Array.isArray(record.execs)
            ? record.execs
            : null;
    if (!plan && !exec)
        return null;
    return {
        plan: /** @type {DelegationPlanRowLike[]} */ (plan ?? []),
        exec: /** @type {DelegationExecRowLike[]} */ (exec ?? []),
    };
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isUsableNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Creates the delegation-chain estimate-accuracy scorer.
 *
 * Every delegation plan node predicts `{ tokens, costUsd, minutes }` for each
 * child; exec rows report the actuals. For each node with both a latest
 * estimate and actuals, accuracy is the symmetric ratio
 * `min(predicted, actual) / max(predicted, actual)` per dimension, averaged
 * over the dimensions present on both sides (1.0 = perfect forecast). The
 * run-level score is the mean over nodes weighted by predicted `costUsd`
 * (falling back to weight 1 when a node has no positive cost prediction), so
 * misforecasting big nodes matters more.
 *
 * Replans re-forecast, so the LATEST estimate per node wins (plan rows are
 * read in order; later `children[].estimate` entries supersede earlier ones,
 * as do later `actual`s). Plan rows' `subtreeEstimate` rollups are derived
 * and not scored. Rows are read from the scored `output` (preferred) or
 * `context` as a `{ plan|plans, exec|execs }` payload; nodes missing either
 * side are skipped, and with nothing to score the scorer no-ops (score 1,
 * `meta.skipped`).
 *
 * @returns {Scorer}
 */
export function estimateAccuracyScorer() {
    return createScorer({
        id: "estimate-accuracy",
        name: "Estimate Accuracy",
        description: "Compares each node's latest predicted tokens/costUsd/minutes against actuals (symmetric ratio, cost-weighted mean)",
        score: async ({ output, context }) => {
            const payload = toEstimatePayload(output) ?? toEstimatePayload(context);
            if (!payload) {
                return {
                    score: 1,
                    reason: "No delegation estimate data available; skipping",
                    meta: { skipped: true },
                };
            }
            /** @type {Map<string, DelegationEstimate>} latest estimate per node */
            const estimates = new Map();
            for (const row of payload.plan) {
                for (const child of row?.children ?? []) {
                    const id = child?.logicalId ?? child?.id;
                    if (typeof id === "string" &&
                        typeof child?.estimate === "object" &&
                        child.estimate !== null) {
                        estimates.set(id, child.estimate);
                    }
                }
            }
            /** @type {Map<string, DelegationEstimate>} latest actual per node */
            const actuals = new Map();
            for (const row of payload.exec) {
                const id = row?.logicalId ?? row?.id;
                if (typeof id === "string" &&
                    typeof row?.actual === "object" &&
                    row.actual !== null) {
                    actuals.set(id, row.actual);
                }
            }
            /** @type {{ logicalId: string; predicted: DelegationEstimate; actual: DelegationEstimate; ratio: number; weight: number; dimensions: Record<string, number> }[]} */
            const nodes = [];
            let total = 0;
            let weightSum = 0;
            let predictedUsd = 0;
            let actualUsd = 0;
            for (const [id, predicted] of estimates) {
                const actual = actuals.get(id);
                if (!actual)
                    continue;
                /** @type {Record<string, number>} */
                const dimensions = {};
                let dimTotal = 0;
                let dimCount = 0;
                for (const dim of DIMENSIONS) {
                    const p = predicted[dim];
                    const a = actual[dim];
                    if (!isUsableNumber(p) || !isUsableNumber(a))
                        continue;
                    // Symmetric ratio (min/max): predicting double costs the same as predicting half; both zero is a perfect 1.
                    const ratio = p === 0 && a === 0 ? 1 : Math.min(p, a) / Math.max(p, a);
                    dimensions[dim] = ratio;
                    dimTotal += ratio;
                    dimCount++;
                }
                if (dimCount === 0)
                    continue;
                const ratio = dimTotal / dimCount;
                const weight = isUsableNumber(predicted.costUsd) && predicted.costUsd > 0
                    ? predicted.costUsd
                    : 1;
                nodes.push({ logicalId: id, predicted, actual, ratio, weight, dimensions });
                total += ratio * weight;
                weightSum += weight;
                if (isUsableNumber(predicted.costUsd))
                    predictedUsd += predicted.costUsd;
                if (isUsableNumber(actual.costUsd))
                    actualUsd += actual.costUsd;
            }
            if (nodes.length === 0) {
                return {
                    score: 1,
                    reason: "No node has both an estimate and actuals; skipping",
                    meta: { skipped: true },
                };
            }
            const score = Math.max(0, Math.min(1, total / weightSum));
            return {
                score,
                reason: `${nodes.length} node(s) forecast vs actual; cost-weighted accuracy ${score.toFixed(2)} (predicted $${predictedUsd.toFixed(2)}, actual $${actualUsd.toFixed(2)})`,
                meta: { nodes, totals: { predictedUsd, actualUsd } },
            };
        },
    });
}
