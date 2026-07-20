/**
 * Deterministic content hash for event payloads: canonical JSON (recursively
 * sorted object keys) digested with two independently-seeded FNV-1a passes
 * plus the canonical length. Used by the prefix cache to validate folded
 * history by CONTENT — an in-place payload replacement at the same
 * (nodeId, iteration) retains its seq but must still invalidate the cache,
 * so (count, maxSeq) style checks are never enough.
 * @param {unknown} value
 * @returns {string}
 */
export function stableHash(value) {
    const canonical = stableStringify(value);
    return `${fnv1a(canonical, 0x811c9dc5)}:${fnv1a(canonical, 0x01000193)}:${canonical.length}`;
}
/**
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
    if (value === undefined) return "undefined";
    return JSON.stringify(value, (_key, entry) => {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            /** @type {Record<string, unknown>} */
            const sorted = {};
            for (const key of Object.keys(entry).sort()) {
                sorted[key] = /** @type {Record<string, unknown>} */ (entry)[key];
            }
            return sorted;
        }
        return entry;
    });
}
/**
 * @param {string} input
 * @param {number} seed
 * @returns {string}
 */
function fnv1a(input, seed) {
    let hash = seed >>> 0;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16);
}
