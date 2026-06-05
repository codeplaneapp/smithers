/** @typedef {import("./UsageWindow.ts").UsageWindow} UsageWindow */

/**
 * Builds one percent window from a `{ utilization, resets_at }` block as
 * returned by `GET https://api.anthropic.com/api/oauth/usage`.
 *
 * @param {unknown} block
 * @param {string} id
 * @param {string} label
 * @returns {UsageWindow | undefined}
 */
function windowFrom(block, id, label) {
    if (!block || typeof block !== "object") return undefined;
    const util = /** @type {{ utilization?: unknown }} */ (block).utilization;
    if (typeof util !== "number") return undefined;
    const resetsAt = /** @type {{ resets_at?: unknown }} */ (block).resets_at;
    return {
        id,
        label,
        unit: "percent",
        usedPercent: util,
        resetsAt: typeof resetsAt === "string" ? resetsAt : undefined,
    };
}

/**
 * Normalizes the Claude Code subscription usage payload into usage windows. The
 * payload powers the in-CLI `/usage` view: a 5-hour rolling window, a weekly
 * window, and optional per-model weekly windows.
 *
 * @param {unknown} payload
 * @returns {UsageWindow[]}
 */
export function parseClaudeOauthUsage(payload) {
    if (!payload || typeof payload !== "object") return [];
    const p = /** @type {Record<string, unknown>} */ (payload);
    const windows = [];
    const fiveHour = windowFrom(p.five_hour, "5h", "5-hour session");
    if (fiveHour) windows.push(fiveHour);
    const weekly = windowFrom(p.seven_day, "weekly", "weekly");
    if (weekly) windows.push(weekly);
    const opus = windowFrom(p.seven_day_opus, "weekly-opus", "weekly (Opus)");
    if (opus) windows.push(opus);
    const sonnet = windowFrom(p.seven_day_sonnet, "weekly-sonnet", "weekly (Sonnet)");
    if (sonnet) windows.push(sonnet);
    return windows;
}
