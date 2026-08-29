/**
 * Read a dot-separated path (e.g. `"issue.id"`) out of a decoded JSON value.
 * Returns `undefined` when any segment is missing or the value is not an
 * object along the way. An empty/null/undefined path returns the value itself.
 * @param {unknown} value
 * @param {string | null | undefined} [path]
 * @returns {unknown}
 */
export function readJsonPath(value, path) {
  if (path === undefined || path === null || path === "") {
    return value;
  }
  let current = value;
  for (const segment of String(path).split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = /** @type {Record<string, unknown>} */ (current)[segment];
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}
