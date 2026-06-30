import type { GatewayRunNode } from "@smithers-orchestrator/gateway-client";

export type GraphPos = { col: number; row: number };

export type GraphEdge = { fromId: string; toId: string };

export type GraphLayout = {
  positions: Map<string, GraphPos>;
  /** colGroups[col] = array of nodeIds in that column, top to bottom */
  colGroups: string[][];
  edges: GraphEdge[];
  numCols: number;
  maxRows: number;
};

/**
 * BFS from root(s) to assign a column depth to each node.
 * A node's column = max depth reached across all paths to it,
 * so that nodes always appear to the RIGHT of all their parents.
 */
export function computeColumnDepths(
  nodes: ReadonlyArray<GatewayRunNode>,
  root: GatewayRunNode | null,
): Map<string, number> {
  const nodeMap = new Map<string, GatewayRunNode>();
  for (const n of nodes) nodeMap.set(n.id, n);

  const depths = new Map<string, number>();

  function bfsFrom(startId: string, startDepth: number) {
    const queue: Array<[string, number]> = [[startId, startDepth]];
    while (queue.length > 0) {
      const [id, d] = queue.shift()!;
      const prev = depths.get(id) ?? -1;
      if (d <= prev) continue;
      depths.set(id, d);
      const n = nodeMap.get(id);
      for (const childId of n?.childIds ?? []) {
        if (nodeMap.has(childId)) queue.push([childId, d + 1]);
      }
    }
  }

  if (root) {
    bfsFrom(root.id, 0);
  } else {
    // Start BFS from every parentless node
    const rootNodes = nodes.filter(
      (n) => !n.parentId || !nodeMap.has(n.parentId),
    );
    for (const n of rootNodes) bfsFrom(n.id, 0);
  }

  // Any node not reached by BFS gets column 0
  for (const n of nodes) {
    if (!depths.has(n.id)) depths.set(n.id, 0);
  }

  return depths;
}

export function computeGraphLayout(
  nodes: ReadonlyArray<GatewayRunNode>,
  root: GatewayRunNode | null,
): GraphLayout {
  if (nodes.length === 0) {
    return { positions: new Map(), colGroups: [], edges: [], numCols: 0, maxRows: 0 };
  }

  const depths = computeColumnDepths(nodes, root);

  const colMap = new Map<number, string[]>();
  for (const n of nodes) {
    const col = depths.get(n.id) ?? 0;
    if (!colMap.has(col)) colMap.set(col, []);
    colMap.get(col)!.push(n.id);
  }

  const numCols = colMap.size > 0 ? Math.max(...colMap.keys()) + 1 : 0;
  const colGroups: string[][] = [];
  for (let i = 0; i < numCols; i++) {
    colGroups[i] = colMap.get(i) ?? [];
  }

  const positions = new Map<string, GraphPos>();
  for (let c = 0; c < numCols; c++) {
    for (let r = 0; r < (colGroups[c]?.length ?? 0); r++) {
      const id = colGroups[c]?.[r];
      if (id) positions.set(id, { col: c, row: r });
    }
  }

  const nodeMap = new Map<string, GatewayRunNode>();
  for (const n of nodes) nodeMap.set(n.id, n);

  const edges: GraphEdge[] = [];
  for (const n of nodes) {
    for (const childId of n.childIds ?? []) {
      if (nodeMap.has(childId)) edges.push({ fromId: n.id, toId: childId });
    }
  }

  const maxRows = colGroups.reduce((m, g) => Math.max(m, g?.length ?? 0), 0);

  return { positions, colGroups, edges, numCols, maxRows };
}

/**
 * For a connector gap between col `fromCol` and col `fromCol+1`,
 * return the set of (fromRow, toRow) pairs for direct (adjacent-column) edges.
 */
export function edgesForConnector(
  edges: GraphEdge[],
  positions: Map<string, GraphPos>,
  fromCol: number,
): Array<{ fromRow: number; toRow: number }> {
  const result: Array<{ fromRow: number; toRow: number }> = [];
  for (const e of edges) {
    const fp = positions.get(e.fromId);
    const tp = positions.get(e.toId);
    if (fp && tp && fp.col === fromCol && tp.col === fromCol + 1) {
      result.push({ fromRow: fp.row, toRow: tp.row });
    }
  }
  return result;
}

/**
 * For a given connector slot (= row in the right column),
 * does any edge arrive at this slot from the left column?
 */
export function hasIncomingEdge(
  connectorEdges: Array<{ fromRow: number; toRow: number }>,
  toRow: number,
): boolean {
  return connectorEdges.some((e) => e.toRow === toRow);
}
