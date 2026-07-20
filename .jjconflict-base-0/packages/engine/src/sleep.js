/**
 * Portable sleep helper used by plain async engine loops.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
