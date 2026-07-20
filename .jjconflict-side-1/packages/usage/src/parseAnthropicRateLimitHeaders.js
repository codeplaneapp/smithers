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
 * @param {string} prefix
 * @param {string} id
 * @param {string} label
 * @returns {UsageWindow | undefined}
 */
function countWindow(get, prefix, id, label) {
    const limit = int(get(`${prefix}-limit`));
    const remaining = int(get(`${prefix}-remaining`));
    if (limit === undefined && remaining === undefined) return undefined;
    const reset = get(`${prefix}-reset`);
    const used = limit !== undefined && remaining !== undefined ? Math.max(0, limit - remaining) : undefined;
    return {
        id,
        label,
        unit: "count",
        limit,
        remaining,
        used,
        resetsAt: typeof reset === "string" ? reset : undefined,
    };
}

/**
 * Parses Anthropic rate-limit response headers into usage windows. Anthropic
 * returns RFC-3339 reset timestamps directly, so no clock math is needed.
 *
 * Pass a getter, e.g. `(name) => response.headers.get(name)`.
 *
 * @param {(name: string) => string | null | undefined} get
 * @returns {UsageWindow[]}
 */
export function parseAnthropicRateLimitHeaders(get) {
    const windows = [];
    const requests = countWindow(get, "anthropic-ratelimit-requests", "requests-per-min", "requests/min");
    if (requests) windows.push(requests);
    const tokens = countWindow(get, "anthropic-ratelimit-tokens", "tokens-per-min", "tokens/min");
    if (tokens) windows.push(tokens);
    const input = countWindow(get, "anthropic-ratelimit-input-tokens", "input-tokens-per-min", "input tokens/min");
    if (input) windows.push(input);
    const output = countWindow(get, "anthropic-ratelimit-output-tokens", "output-tokens-per-min", "output tokens/min");
    if (output) windows.push(output);
    return windows;
}
