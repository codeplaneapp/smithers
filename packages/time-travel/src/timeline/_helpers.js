/**
 * @param {number} ms
 * @returns {string}
 */
export function formatTimestamp(ms) {
    return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}
