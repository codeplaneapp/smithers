
/** @typedef {import("./MemoryNamespace.ts").MemoryNamespace} MemoryNamespace */

/**
 * @param {string} id
 * @returns {string}
 */
function encodeNamespaceId(id) {
    return id.replace(/%/g, "%25").replace(/:/g, "%3A");
}

/**
 * @param {MemoryNamespace} ns
 * @returns {string}
 */
export function namespaceToString(ns) {
    return `${ns.kind}:${encodeNamespaceId(ns.id)}`;
}
