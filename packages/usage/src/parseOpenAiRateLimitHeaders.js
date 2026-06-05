import { parseDurationSeconds } from "./parseDurationSeconds.js";

/** @typedef {import("./UsageWindow.ts").UsageWindow} UsageWindow */

/**
 * @param {string | null | undefined} value
 * @returns {number | undefined}
 */
function int(value) {
    if (value == null) return undefined;
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? undefined : n;
}

/**
 * @param {(name: string) => string | null | undefined} get
 * @param {string} suffix
 * @param {string} id
 * @param {string} label
 * @param {number} nowMs
 * @returns {UsageWindow | undefined}
 */
function countWindow(get, suffix, id, label, nowMs) {
    const limit = int(get(`x-ratelimit-limit-${suffix}`));
    const remaining = int(get(`x-ratelimit-remaining-${suffix}`));
    if (limit === undefined && remaining === undefined) return undefined;
    const resetSeconds = parseDurationSeconds(get(`x-ratelimit-reset-${suffix}`));
    const used = limit !== undefined && remaining !== undefined ? limit - remaining : undefined;
    return {
        id,
        label,
        unit: "count",
        limit,
        remaining,
        used,
        resetsAt: resetSeconds !== undefined
            ? new Date(nowMs + resetSeconds * 1000).toISOString()
            : undefined,
    };
}

/**
 * Parses OpenAI rate-limit response headers into usage windows. OpenAI's reset
 * headers are Go-duration strings relative to "now", so `nowMs` is added to
 * produce an absolute ISO reset time (pass a fixed value in tests).
 *
 * Pass a getter, e.g. `(name) => response.headers.get(name)`.
 *
 * @param {(name: string) => string | null | undefined} get
 * @param {number} [nowMs]
 * @returns {UsageWindow[]}
 */
export function parseOpenAiRateLimitHeaders(get, nowMs = Date.now()) {
    const windows = [];
    const requests = countWindow(get, "requests", "requests-per-min", "requests/min", nowMs);
    if (requests) windows.push(requests);
    const tokens = countWindow(get, "tokens", "tokens-per-min", "tokens/min", nowMs);
    if (tokens) windows.push(tokens);
    return windows;
}
