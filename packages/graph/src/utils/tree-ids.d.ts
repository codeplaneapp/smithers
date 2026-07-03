/**
 * @param {string} prefix
 * @param {number[]} path
 * @returns {string}
 */
declare function stablePathId(prefix: string, path: number[]): string;
/**
 * @param {unknown} explicitId
 * @param {string} prefix
 * @param {number[]} path
 * @returns {string}
 */
declare function resolveStableId(explicitId: unknown, prefix: string, path: number[]): string;

export { resolveStableId, stablePathId };
