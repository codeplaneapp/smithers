import type { GatewayRunNode } from "./GatewayRunNode.ts";

export function flattenGatewayRunNode(root: GatewayRunNode | null | undefined): GatewayRunNode[] {
  if (!root) return [];
  const rows: GatewayRunNode[] = [];
  const visit = (node: GatewayRunNode, parentId?: string) => {
    const children = node.children ?? [];
    const childIds = children.map((child) => child.id);
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
