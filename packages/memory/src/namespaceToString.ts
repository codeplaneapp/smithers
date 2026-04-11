import type { MemoryNamespace } from "./MemoryNamespace";

export function namespaceToString(ns: MemoryNamespace): string {
  return `${ns.kind}:${ns.id}`;
}
