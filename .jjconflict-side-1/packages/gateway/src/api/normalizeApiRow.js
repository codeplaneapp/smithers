const SNAKE_SEGMENT = /_([a-z0-9])/g;

/**
 * @param {string} key
 * @returns {string}
 */
function toCamelKey(key) {
  return key.replace(SNAKE_SEGMENT, (_, /** @type {string} */ char) => char.toUpperCase());
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function normalizeValue(value) {
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value.toString();
  }
  return value;
}

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Record<string, unknown>}
 */
export function normalizeApiRow(row) {
  /** @type {Record<string, unknown>} */
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    const camelKey = toCamelKey(key);
    normalized[camelKey] = normalizeValue(value);
  }
  return normalized;
}
