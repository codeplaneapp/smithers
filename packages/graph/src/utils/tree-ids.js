/**
 * @param {string} prefix
 * @param {number[]} path
 * @returns {string}
 */
export function stablePathId(prefix, path) {
    if (path.length === 0)
        return `${prefix}:root`;
    return `${prefix}:${path.join(".")}`;
}
/**
 * @param {unknown} explicitId
 * @param {string} prefix
 * @param {number[]} path
 * @returns {string}
 */
export function resolveStableId(explicitId, prefix, path) {
    if (typeof explicitId === "string" && explicitId.trim().length > 0) {
        return explicitId;
    }
    return stablePathId(prefix, path);
}
