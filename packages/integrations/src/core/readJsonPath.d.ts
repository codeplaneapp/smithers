/**
 * Read a dot-separated path (e.g. `"issue.id"`) out of a decoded JSON value.
 * Returns `undefined` when any segment is missing or the value is not an
 * object along the way. An empty/null/undefined path returns the value itself.
 * @param {unknown} value
 * @param {string | null | undefined} [path]
 * @returns {unknown}
 */
declare function readJsonPath(value: unknown, path?: string | null | undefined): unknown;

export { readJsonPath };
