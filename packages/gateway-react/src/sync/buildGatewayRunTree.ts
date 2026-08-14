import { runNodeKey, type GatewayRunNode } from "@smthrs/gateway-client";

/** Row key of the synthetic root emitted when the flat rows form a forest. */
export const SYNTHETIC_RUN_ROOT_KEY = "__run-root__";

/**
 * Active states outrank terminal ones so a live run reads as live; among
 * terminal states, `failed` outranks `cancelled` outranks `ok`. Rows arrive
 * with normalized NodeStatus values: both `snapshotToGatewayRunNode` and
 * `mapSmithersElectricRow` collapse the persisted lifecycle vocabulary
 * (`in-progress`, `finished`, …) onto these tones before the tree is built.
 */
const STATUS_PRIORITY = ["running", "waiting", "queued", "failed", "cancelled"] as const;

function forestStatus(roots: readonly GatewayRunNode[]): string {
  for (const status of STATUS_PRIORITY) {
    if (roots.some((root) => root.status === status)) return status;
  }
  return roots[0]?.status ?? "queued";
}

/**
 * Rebuild the nested `children` tree from the flat rows the `nodes` collection
 * stores. Rows are linked by their unique `key` ({@link runNodeKey}), not the
 * logical `id`, so loop/retry attempts that share an `id` stay distinct nodes
 * instead of one swallowing the other.
 *
 * Links are read from BOTH sides: a parent's `childIds` and each row's
 * `parentId` (rows synced from durable state may carry only one side, or —
 * multiplayer `_smithers_nodes` rows — neither). Every row nothing links to is
 * a root; a multi-root forest is preserved beneath a synthetic `workflow` root
 * (mirroring the local snapshot's root) instead of all but the first root
 * being dropped.
 */
export function buildGatewayRunTree(rows: readonly GatewayRunNode[]): GatewayRunNode | null {
  if (rows.length === 0) return null;
  const byKey = new Map(rows.map((row) => [runNodeKey(row), row]));

  // Children a `parentId` names that the parent's own `childIds` omit, in row
  // order — so parentId-only rows still reconstruct their nesting.
  const derivedChildren = new Map<string, GatewayRunNode[]>();
  const referenced = new Set<string>();
  for (const row of rows) {
    for (const key of row.childIds ?? []) {
      if (key !== runNodeKey(row)) referenced.add(key);
    }
  }
  for (const row of rows) {
    const key = runNodeKey(row);
    const parentKey = row.parentId;
    if (!parentKey || parentKey === key || !byKey.has(parentKey)) continue;
    referenced.add(key);
    if (byKey.get(parentKey)?.childIds?.includes(key)) continue;
    const siblings = derivedChildren.get(parentKey) ?? [];
    siblings.push(row);
    derivedChildren.set(parentKey, siblings);
  }

  const visited = new Set<string>();
  const build = (node: GatewayRunNode): GatewayRunNode => {
    visited.add(runNodeKey(node));
    const children: GatewayRunNode[] = [];
    for (const key of node.childIds ?? []) {
      const child = byKey.get(key);
      if (!child || visited.has(runNodeKey(child))) continue;
      children.push(build(child));
    }
    for (const child of derivedChildren.get(runNodeKey(node)) ?? []) {
      if (visited.has(runNodeKey(child))) continue;
      children.push(build(child));
    }
    return { ...node, children };
  };

  const roots: GatewayRunNode[] = [];
  for (const row of rows) {
    if (!referenced.has(runNodeKey(row)) && !visited.has(runNodeKey(row))) roots.push(build(row));
  }
  // Rows reachable only through cycles never surface as unreferenced roots;
  // sweep them in row order so no node is silently dropped.
  for (const row of rows) {
    if (!visited.has(runNodeKey(row))) roots.push(build(row));
  }

  if (roots.length === 1) return roots[0];
  return {
    key: SYNTHETIC_RUN_ROOT_KEY,
    id: SYNTHETIC_RUN_ROOT_KEY,
    name: "Run",
    kind: "workflow",
    status: forestStatus(roots),
    childIds: roots.map(runNodeKey),
    children: roots,
  };
}
