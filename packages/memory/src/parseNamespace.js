/** @typedef {import("./MemoryNamespace.ts").MemoryNamespace} MemoryNamespace */

// Must stay in sync with the MemoryNamespaceKind union in MemoryNamespaceKind.ts.
const MEMORY_NAMESPACE_KINDS = ["workflow", "agent", "user", "global"];

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
  // Undo namespaceToString's escaping: decode %3A before %25 (reverse of the
  // encode order) so a literal "%25" in the id round-trips.
  return { kind, id: id.replace(/%3A/g, ":").replace(/%25/g, "%") };
}
