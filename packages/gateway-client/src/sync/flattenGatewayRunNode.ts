import type { GatewayRunNode } from "./GatewayRunNode.ts";

export function flattenGatewayRunNode(root: GatewayRunNode | null | undefined): GatewayRunNode[] {
  if (!root) return [];
  const rows: GatewayRunNode[] = [];
  const visited = new Set<string>();
  const visit = (node: GatewayRunNode, parentId?: string) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    const children = node.children ?? [];
    const childIds = Array.from(new Set(children.map((child) => child.id)));
    rows.push({
      ...node,
      ...(parentId ? { parentId } : {}),
      childIds,
      children: undefined,
    });
    for (const child of children) {
      visit(child, node.id);
    }
  };
  visit(root);
  return rows;
}
