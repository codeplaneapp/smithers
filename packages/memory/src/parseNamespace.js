
/** @typedef {import("./MemoryNamespace.ts").MemoryNamespace} MemoryNamespace */

const MEMORY_NAMESPACE_KINDS = ["workflow", "agent", "user", "global"];

/**
 * @param {string} id
 * @returns {string}
 */
function decodeNamespaceId(id) {
    return id.replace(/%3A/g, ":").replace(/%25/g, "%");
}

/**
 * @param {string} str
 * @returns {MemoryNamespace}
 */
export function parseNamespace(str) {
    const idx = str.indexOf(":");
    if (idx < 0) {
        return { kind: "global", id: str };
    }
    const kind = str.slice(0, idx);
    const id = str.slice(idx + 1);
    if (!MEMORY_NAMESPACE_KINDS.includes(kind)) {
        return { kind: "global", id: str };
    }
    return { kind, id: decodeNamespaceId(id) };
}
