import { runNodeKey, type GatewayRunNode } from "@smithers-orchestrator/gateway-client";

/**
 * Rebuild the nested `children` tree from the flat rows the `nodes` collection
 * stores. Rows are linked by their unique `key` ({@link runNodeKey}), not the
 * logical `id`, so loop/retry attempts that share an `id` stay distinct nodes
 * instead of one swallowing the other.
 */
export function buildGatewayRunTree(rows: readonly GatewayRunNode[]): GatewayRunNode | null {
  if (rows.length === 0) return null;
  const byKey = new Map(rows.map((row) => [runNodeKey(row), row]));
  const visited = new Set<string>();
  const build = (node: GatewayRunNode): GatewayRunNode => {
    visited.add(runNodeKey(node));
    const children: GatewayRunNode[] = [];
    for (const key of node.childIds ?? []) {
      const child = byKey.get(key);
      if (!child || visited.has(runNodeKey(child))) continue;
      children.push(build(child));
    }
    return { ...node, children };
  };
  const root = rows.find((row) => !row.parentId) ?? rows[0];
  return build(root);
}
