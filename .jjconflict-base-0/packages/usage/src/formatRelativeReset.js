import { humanizeDurationShort } from "./humanizeDurationShort.js";

/**
 * Formats an ISO reset timestamp as a relative "resets in" string. Returns an
 * empty string when there is no timestamp, and `"now"` when it is in the past.
 *
 * @param {string | undefined} resetsAt
 * @param {number} [nowMs]
 * @returns {string}
 */
export function formatRelativeReset(resetsAt, nowMs = Date.now()) {
    if (!resetsAt) return "";
    const ms = Date.parse(resetsAt);
    if (Number.isNaN(ms)) return "";
    return humanizeDurationShort((ms - nowMs) / 1000);
}
