/**
 * Estimate the USD cost of a single token-usage report.
 *
 * `TokenUsageReported` carries token counts only — providers do not report a
 * per-call dollar figure through the AI SDK usage object — so Aspects cost
 * budgets are derived from token counts and a small built-in price table.
 *
 * Prices are list prices in USD per 1,000,000 tokens and are intentionally
 * approximate: a cost budget is a spend guard, not a billing system. Models
 * are matched by family substring (case-insensitive) so minor id/date suffix
 * drift still resolves. Unknown models contribute `0` — token and latency
 * budgets still protect those runs; only the cost budget is unable to estimate
 * spend for a model it does not recognize.
 *
 * @typedef {{
 *   model?: string;
 *   inputTokens?: number;
 *   outputTokens?: number;
 *   cacheReadTokens?: number;
 *   cacheWriteTokens?: number;
 *   reasoningTokens?: number;
 * }} UsageLike
 */

/**
 * @typedef {{ match: (model: string) => boolean; inputPerM: number; outputPerM: number }} PriceRule
 */

/**
 * Ordered price rules; first match wins. Keep families ahead of generic
 * fallbacks (e.g. match `gpt-4o` before a bare `gpt-4`).
 * @type {ReadonlyArray<PriceRule>}
 */
const PRICE_RULES = [
    // Anthropic Claude
    { match: (m) => m.includes("opus"), inputPerM: 15, outputPerM: 75 },
    { match: (m) => m.includes("sonnet"), inputPerM: 3, outputPerM: 15 },
    { match: (m) => m.includes("haiku"), inputPerM: 0.8, outputPerM: 4 },
    // OpenAI
    { match: (m) => m.includes("gpt-5") || m.includes("gpt5"), inputPerM: 1.25, outputPerM: 10 },
    { match: (m) => m.includes("gpt-4o") || m.includes("gpt4o"), inputPerM: 2.5, outputPerM: 10 },
    { match: (m) => m.includes("gpt-4.1") || m.includes("gpt-4-1"), inputPerM: 2, outputPerM: 8 },
    { match: (m) => m.includes("o3") || m.includes("o1"), inputPerM: 15, outputPerM: 60 },
    // Google Gemini
    { match: (m) => m.includes("gemini") && m.includes("flash"), inputPerM: 0.3, outputPerM: 2.5 },
    { match: (m) => m.includes("gemini"), inputPerM: 1.25, outputPerM: 10 },
];

/**
 * @param {unknown} value
 * @returns {number}
 */
function num(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * @param {UsageLike} usage
 * @returns {number} estimated cost in USD (0 when the model is unknown)
 */
export function estimateCostUsd(usage) {
    if (!usage || typeof usage !== "object") {
        return 0;
    }
    const model = typeof usage.model === "string" ? usage.model.toLowerCase() : "";
    const rule = PRICE_RULES.find((candidate) => candidate.match(model));
    if (!rule) {
        return 0;
    }
    // Cache reads/writes and reasoning tokens are billed on the input/output
    // sides respectively; fold them in at the base rate as an approximation.
    const inputTokens = num(usage.inputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens);
    const outputTokens = num(usage.outputTokens) + num(usage.reasoningTokens);
    return (inputTokens / 1_000_000) * rule.inputPerM + (outputTokens / 1_000_000) * rule.outputPerM;
}
