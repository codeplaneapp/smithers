import { runNodeKey, type GatewayRunNode } from "@smthrs/gateway-client";

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
  // Index by the unique row `key` (not the logical `id`): `childIds`/`parentId`
  // link by `key`, and loop/retry attempts share an `id`, so id-keying would
  // merge their graph positions.
  const nodeMap = new Map<string, GatewayRunNode>();
  for (const n of nodes) nodeMap.set(runNodeKey(n), n);

  const depths = new Map<string, number>();

  function bfsFrom(startKey: string, startDepth: number) {
    const queue: Array<[string, number, readonly string[]]> = [[startKey, startDepth, []]];
    while (queue.length > 0) {
      const [key, d, path] = queue.shift()!;
      if (path.includes(key)) continue;
      const prev = depths.get(key) ?? -1;
      if (d <= prev) continue;
      depths.set(key, d);
      const n = nodeMap.get(key);
      const nextPath = [...path, key];
      for (const childKey of n?.childIds ?? []) {
        if (nodeMap.has(childKey)) queue.push([childKey, d + 1, nextPath]);
      }
    }
  }

  if (root) {
    bfsFrom(runNodeKey(root), 0);
  } else {
    // Start BFS from every parentless node
    const rootNodes = nodes.filter((n) => !n.parentId || !nodeMap.has(n.parentId));
    for (const n of rootNodes) bfsFrom(runNodeKey(n), 0);
  }

  // Any node not reached by BFS gets column 0
  for (const n of nodes) {
    if (!depths.has(runNodeKey(n))) depths.set(runNodeKey(n), 0);
  }

  return depths;
}

export function computeGraphLayout(nodes: ReadonlyArray<GatewayRunNode>, root: GatewayRunNode | null): GraphLayout {
  if (nodes.length === 0) {
    return { positions: new Map(), colGroups: [], edges: [], numCols: 0, maxRows: 0 };
  }

  const depths = computeColumnDepths(nodes, root);

  const colMap = new Map<number, string[]>();
  for (const n of nodes) {
    const col = depths.get(runNodeKey(n)) ?? 0;
    if (!colMap.has(col)) colMap.set(col, []);
    colMap.get(col)!.push(runNodeKey(n));
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
  for (const n of nodes) nodeMap.set(runNodeKey(n), n);

  const edges: GraphEdge[] = [];
  for (const n of nodes) {
    for (const childKey of n.childIds ?? []) {
      if (nodeMap.has(childKey)) edges.push({ fromId: runNodeKey(n), toId: childKey });
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
 * The connector arrow drawn between two graph columns. Compact terminals
 * (< COMPACT_WIDTH cols) use a narrower glyph. Callers size the connector
 * `<box>`/`<text>` cells from this string's length so the arrow can never
 * overflow its column (see #582): every glyph here is a single-column BMP
 * character, so `.length` equals the rendered width.
 */
export function connectorArrow(compact: boolean): string {
  return compact ? " → " : " ──▶ ";
}

/**
 * For a given connector slot (= row in the right column),
 * does any edge arrive at this slot from the left column?
 */
export function hasIncomingEdge(connectorEdges: Array<{ fromRow: number; toRow: number }>, toRow: number): boolean {
  return connectorEdges.some((e) => e.toRow === toRow);
}
