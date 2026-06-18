import type { GatewayRunNode } from "@smithers-orchestrator/gateway-client";

/**
 * Rebuild the nested `children` tree from the flat, `childIds`-keyed rows the
 * `nodes` collection stores. The collection holds the surgical diff of
 * `snapshotToGatewayRunNode`'s output (reconciled per devtools frame), so this
 * is a cheap pointer-chase over already-deduped rows.
 */
export function buildGatewayRunTree(rows: readonly GatewayRunNode[]): GatewayRunNode | null {
  if (rows.length === 0) return null;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const visited = new Set<string>();
  const build = (node: GatewayRunNode): GatewayRunNode => {
    visited.add(node.id);
    const children: GatewayRunNode[] = [];
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (!child || visited.has(child.id)) continue;
      children.push(build(child));
    }
    return { ...node, children };
  };
  const root = rows.find((row) => !row.parentId) ?? rows[0];
  return build(root);
}
