/**
 * Formats a number of seconds as a short human duration, e.g. `"2h 41m"`,
 * `"5d 3h"`, `"42s"`. Used for "resets in" columns. Negative input renders as
 * `"now"`.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function humanizeDurationShort(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "now";
    const total = Math.round(seconds);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
}
