import { runNodeKey, type GatewayRunNode } from "@smithers-orchestrator/gateway-client";

export type FlatNode = {
  node: GatewayRunNode;
  depth: number;
  hasChildren: boolean;
  isCollapsed: boolean;
};

export type TabId = "output" | "logs" | "diff" | "props";

export const ALL_TABS: readonly TabId[] = ["output", "logs", "diff", "props"];

export function flattenTree(
  nodes: ReadonlyArray<GatewayRunNode>,
  root: GatewayRunNode | null,
  collapsed: Set<string>,
): FlatNode[] {
  if (!root) {
    return nodes.map((node) => ({
      node,
      depth: 0,
      hasChildren: (node.childIds?.length ?? 0) > 0,
      isCollapsed: collapsed.has(runNodeKey(node)),
    }));
  }

  // Index by the unique row `key` (not the logical `id`) so loop/retry attempts
  // sharing an `id` resolve to the right row; `childIds`/`collapsed` are keyed
  // the same way.
  const nodeMap = new Map<string, GatewayRunNode>();
  for (const n of nodes) nodeMap.set(runNodeKey(n), n);

  const result: FlatNode[] = [];

  function walk(n: GatewayRunNode, depth: number) {
    const childIds = n.childIds ?? [];
    const hasChildren = childIds.length > 0;
    const isCollapsed = collapsed.has(runNodeKey(n));
    result.push({ node: n, depth, hasChildren, isCollapsed });
    if (!isCollapsed && hasChildren) {
      for (const childId of childIds) {
        const child = nodeMap.get(childId);
        if (child) walk(child, depth + 1);
      }
    }
  }

  walk(root, 0);
  return result;
}

export function nodeGlyph(status: string): string {
  switch (status) {
    case "done":
    case "completed":
    case "ok":
      return "✓";
    case "running":
    case "active":
      return "●";
    case "waiting":
    case "paused":
    case "blocked":
    case "waiting_approval":
      return "⏸";
    case "queued":
    case "pending":
    case "idle":
      return "○";
    // A user-cancelled node is terminal but NOT a failure: distinct dim glyph, not
    // the red ✗, so a deliberate cancel doesn't read as an error.
    case "cancelled":
    case "canceled":
      return "⊘";
    case "failed":
    case "error":
      return "✗";
    default:
      return "·";
  }
}

export function nodeGlyphColor(status: string): string {
  switch (status) {
    case "done":
    case "completed":
    case "ok":
      return "#00d787";
    case "running":
    case "active":
      return "#00d7ff";
    case "waiting":
    case "paused":
    case "blocked":
    case "waiting_approval":
      return "#ffaf00";
    // Cancelled: dim grey (terminal but not a failure), mirroring the header's
    // cancelled status dot — never the red failure color.
    case "cancelled":
    case "canceled":
      return "#888888";
    case "failed":
    case "error":
      return "#ff5f5f";
    default:
      return "#6c6c6c";
  }
}

export function nodeChevron(hasChildren: boolean, isCollapsed: boolean): string {
  if (!hasChildren) return "·";
  return isCollapsed ? "▸" : "▾";
}

const CONTAINER_KINDS = ["root", "parallel", "loop", "saga", "try", "workflow", "group"];

export function defaultTab(node: GatewayRunNode): TabId {
  const status = node.status ?? "";
  const kind = (node.kind ?? "").toLowerCase();
  const isContainer = CONTAINER_KINDS.some((k) => kind === k || kind.startsWith(k));
  if (isContainer) return "props";
  if (status === "running" || status === "active") return "logs";
  if (node.output) return "output";
  return "props";
}
