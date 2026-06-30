import { runNodeKey, type GatewayRunNode } from "./GatewayRunNode.ts";

/**
 * Walk the nested run tree into flat rows. Identity is the per-row `key`
 * ({@link runNodeKey}: unique per structural position), NOT the logical `id`:
 * keying on `id` would collapse loop/retry attempts that share a task id but
 * differ by `iteration` into the first row. `parentId`/`childIds` therefore link
 * by `key` too, so the rebuilt tree keeps every attempt as a distinct node.
 */
export function flattenGatewayRunNode(root: GatewayRunNode | null | undefined): GatewayRunNode[] {
  if (!root) return [];
  const rows: GatewayRunNode[] = [];
  const visited = new Set<string>();
  const visit = (node: GatewayRunNode, parentKey?: string) => {
    const key = runNodeKey(node);
    if (visited.has(key)) return;
    visited.add(key);
    const children = node.children ?? [];
    const childIds = Array.from(new Set(children.map((child) => runNodeKey(child))));
    rows.push({
      ...node,
      key,
      ...(parentKey ? { parentId: parentKey } : {}),
      childIds,
      children: undefined,
    });
    for (const child of children) {
      visit(child, key);
    }
  };
  visit(root);
  return rows;
}
