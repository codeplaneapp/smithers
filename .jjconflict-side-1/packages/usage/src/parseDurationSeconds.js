/**
 * Parses a Go-style duration string into seconds. OpenAI's rate-limit reset
 * headers use this format, e.g. `"1s"`, `"6m0s"`, `"1h2m3s"`, `"800ms"`.
 *
 * Returns `undefined` for input it cannot parse, so callers can omit a reset
 * time rather than render a wrong one.
 *
 * @param {string | null | undefined} value
 * @returns {number | undefined}
 */
export function parseDurationSeconds(value) {
    if (value == null) return undefined;
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    // Plain number of seconds, e.g. "30".
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
        const n = Number(trimmed);
        return Number.isFinite(n) ? n : undefined;
    }
    const re = /(\d+(?:\.\d+)?)(ms|us|µs|ns|s|m|h)/g;
    let total = 0;
    let matched = false;
    let position = 0;
    let match;
    while ((match = re.exec(trimmed)) !== null) {
        if (match.index !== position) return undefined;
        position = re.lastIndex;
        matched = true;
        const amount = Number(match[1]);
        switch (match[2]) {
            case "h": total += amount * 3600; break;
            case "m": total += amount * 60; break;
            case "s": total += amount; break;
            case "ms": total += amount / 1000; break;
            case "us":
            case "µs": total += amount / 1_000_000; break;
            case "ns": total += amount / 1_000_000_000; break;
        }
    }
    return matched && position === trimmed.length ? total : undefined;
}
