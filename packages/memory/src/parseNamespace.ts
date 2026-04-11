import type { MemoryNamespace } from "./MemoryNamespace";
import type { MemoryNamespaceKind } from "./MemoryNamespaceKind";

export function parseNamespace(str: string): MemoryNamespace {
  const idx = str.indexOf(":");
  if (idx < 0) {
    return { kind: "global", id: str };
  }
  const kind = str.slice(0, idx) as MemoryNamespaceKind;
  const id = str.slice(idx + 1);
  if (!["workflow", "agent", "user", "global"].includes(kind)) {
    return { kind: "global", id: str };
  }
  return { kind, id };
}
