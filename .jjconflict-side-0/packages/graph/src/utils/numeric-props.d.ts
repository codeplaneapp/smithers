/**
 * Coerce a numeric prop without accepting values that JavaScript would
 * otherwise silently turn into zero or one.
 * @param {unknown} value
 * @returns {number | null}
 */
declare function coerceFiniteNumber(value: unknown): number | null;

export { coerceFiniteNumber };
