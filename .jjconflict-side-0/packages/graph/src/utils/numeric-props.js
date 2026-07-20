/**
 * Coerce a numeric prop without accepting values that JavaScript would
 * otherwise silently turn into zero or one.
 * @param {unknown} value
 * @returns {number | null}
 */
export function coerceFiniteNumber(value) {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value !== "string" || value.trim().length === 0) {
        return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
