/**
 * Converts a camelCase string to snake_case.
 * @param {string} str
 * @returns {string}
 */
export function camelToSnake(str) {
  return str.replace(/([A-Z])/g, "_$1").toLowerCase();
}
