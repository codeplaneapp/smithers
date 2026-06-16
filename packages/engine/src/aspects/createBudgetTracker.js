import { estimateCostUsd } from "./estimateCostUsd.js";

/**
 * @typedef {import("./estimateCostUsd.js").UsageLike} UsageLike
 */
/**
 * @typedef {{ tokens: number; costUsd: number; elapsedMs: number }} BudgetSnapshot
 */
/**
 * @typedef {{
 *   recordUsage: (usage: UsageLike) => void;
 *   snapshot: (nowMsValue: number) => BudgetSnapshot;
 *   readonly tokens: number;
 *   readonly costUsd: number;
 * }} BudgetTracker
 */

/**
 * @param {unknown} value
 * @returns {number}
 */
function num(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Per-run accumulator for Aspects budget enforcement.
 *
 * It sums token usage and estimated cost across every `TokenUsageReported` for
 * the run. The engine seeds it from persisted token-usage events on resume and
 * then feeds it live events, so accumulated usage survives a resume. Wall-clock
 * for latency SLOs is measured from `runStartMs` (the run's creation time,
 * which is persisted), so latency also survives resume.
 *
 * @param {{ runStartMs: number }} opts
 * @returns {BudgetTracker}
 */
export function createBudgetTracker(opts) {
    const runStartMs = num(opts?.runStartMs);
    let tokens = 0;
    let costUsd = 0;
    return {
        get tokens() {
            return tokens;
        },
        get costUsd() {
            return costUsd;
        },
        /** @param {UsageLike} usage */
        recordUsage(usage) {
            if (!usage || typeof usage !== "object") {
                return;
            }
            tokens += num(usage.inputTokens) + num(usage.outputTokens);
            costUsd += estimateCostUsd(usage);
        },
        /** @param {number} nowMsValue */
        snapshot(nowMsValue) {
            return {
                tokens,
                costUsd,
                elapsedMs: Math.max(0, num(nowMsValue) - runStartMs),
            };
        },
    };
}
