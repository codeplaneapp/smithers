/**
 * @typedef {import("@smithers-orchestrator/graph/TaskAspects").TaskAspects} TaskAspects
 * @typedef {import("./createBudgetTracker.js").BudgetSnapshot} BudgetSnapshot
 */
/**
 * @typedef {{
 *   kind: "tokens" | "latency";
 *   limit: number;
 *   current: number;
 *   onExceeded: "fail" | "warn" | "skip-remaining";
 * }} AspectBudgetBreach
 */

/**
 * Decide whether a task's Aspects budgets are exceeded given the run's
 * accumulated usage. Pure: no side effects, no clock — the caller passes a
 * usage snapshot. Checks the scope/run totals (`tokenBudget.max`,
 * `latencySlo.maxMs`) in that order and returns the first breach, or `null`
 * when the task is within budget.
 *
 * The per-task limits (`perTask`) are not evaluated here; only scope totals are
 * enforced at dispatch.
 *
 * @param {TaskAspects | undefined} aspects
 * @param {BudgetSnapshot} usage
 * @returns {AspectBudgetBreach | null}
 */
export function evaluateAspectBudget(aspects, usage) {
    if (!aspects || !usage) {
        return null;
    }
    const { tokenBudget, latencySlo } = aspects;
    if (tokenBudget &&
        typeof tokenBudget.max === "number" &&
        usage.tokens >= tokenBudget.max) {
        return {
            kind: "tokens",
            limit: tokenBudget.max,
            current: usage.tokens,
            onExceeded: tokenBudget.onExceeded ?? "fail",
        };
    }
    if (latencySlo &&
        typeof latencySlo.maxMs === "number" &&
        usage.elapsedMs >= latencySlo.maxMs) {
        return {
            kind: "latency",
            limit: latencySlo.maxMs,
            current: usage.elapsedMs,
            onExceeded: latencySlo.onExceeded ?? "fail",
        };
    }
    return null;
}
