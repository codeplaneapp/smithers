/** @typedef {import("./buildUsageReport.js").UsageProbe} UsageProbe */

/**
 * Google (Gemini, Antigravity, Gemini API) exposes no live "remaining quota"
 * surface to a personal-login or API-key client: there are no rate-limit
 * response headers, only a 429 `RESOURCE_EXHAUSTED` after the wall is hit. The
 * documented path forward is local token-log accounting against published caps
 * (see `publishedCaps.js`), which depends on run-history integration and lands
 * in a later phase. Until then this reports `none` honestly rather than inventing
 * a number.
 *
 * @param {{ provider: string }} account
 * @returns {Promise<UsageProbe>}
 */
export async function googleUsage(account) {
    return {
        source: "none",
        error: "Google exposes no live usage endpoint; local estimate not yet wired",
    };
}
