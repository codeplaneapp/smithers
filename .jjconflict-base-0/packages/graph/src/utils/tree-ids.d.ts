/**
 * @param {string} prefix
 * @param {readonly number[]} path
 * @returns {string}
 */
declare function stablePathId(prefix: string, path: readonly number[]): string;
/**
 * @param {unknown} explicitId
 * @param {string} prefix
 * @param {readonly number[]} path
 * @returns {string}
 */
declare function resolveStableId(explicitId: unknown, prefix: string, path: readonly number[]): string;

export { resolveStableId, stablePathId };
