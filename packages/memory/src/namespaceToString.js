/** @typedef {import("./MemoryNamespace.ts").MemoryNamespace} MemoryNamespace */

/**
 * @param {MemoryNamespace} ns
 * @returns {string}
 */
export function namespaceToString(ns) {
  // Escape % before : so ":" -> "%3A" is unambiguous; parseNamespace decodes
  // in the reverse order.
  return `${ns.kind}:${ns.id.replace(/%/g, "%25").replace(/:/g, "%3A")}`;
}
