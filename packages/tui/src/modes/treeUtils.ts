import { runNodeKey, type GatewayRunNode } from "@smithers-orchestrator/gateway-client";

export type FlatNode = {
  node: GatewayRunNode;
  depth: number;
  hasChildren: boolean;
  isCollapsed: boolean;
};

export type TabId = "output" | "logs" | "diff" | "props";

export const ALL_TABS: readonly TabId[] = ["output", "logs", "diff", "props"];

export function eventKeyName(event: unknown): string {
  if (typeof event === "string") return event;
  if (!event || typeof event !== "object") return "";
  const record = event as Record<string, unknown>;
  if (typeof record.name === "string" && record.name.length > 0) return record.name;
  if (typeof record.raw === "string" && record.raw.length > 0) return record.raw;
  if (typeof record.sequence === "string" && record.sequence.length > 0) return record.sequence;
  return "";
}

/**
 * True when a key event carries a ctrl/meta modifier. OpenTUI's parseKeypress
 * maps raw control bytes 0x01-0x1a to the PLAIN letter name with `ctrl: true`
 * (Ctrl-D → `{ name: "d", ctrl: true }`) and Esc-prefixed letters to the name
 * with `meta: true` — so any handler that routes on the bare name (approval
 * a/d, mode letters, j/k) must drop modified chords first or a reflexive
 * Ctrl-D/Ctrl-L fires an unintended (for approvals, irreversible) action.
 */
export function isModifiedKeyEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const record = event as Record<string, unknown>;
  return record.ctrl === true || record.meta === true;
}

/**
 * Slice window for the tree pane so the focused row stays visible: the pane
 * renders `total` rows into `paneRows` lines and this returns the half-open
 * `[start, end)` range to render, keeping `focusIdx` centered where possible
 * and clamped flush at both list ends (no blank tail, no overshoot).
 */
export function treeScrollWindow(
  total: number,
  paneRows: number,
  focusIdx: number,
): { start: number; end: number } {
  const rows = Math.max(1, paneRows);
  if (total <= rows) return { start: 0, end: total };
  const focus = Math.min(Math.max(focusIdx, 0), total - 1);
  let start = focus - Math.floor(rows / 2);
  if (start < 0) start = 0;
  if (start > total - rows) start = total - rows;
  return { start, end: start + rows };
}

/**
 * Derive the focused row index from a selection ANCHORED BY NODE KEY. The flat
 * list is rebuilt live (rows insert/delete mid-run), so a bare index drifts:
 * growth above the selection silently moves the highlight to a different node
 * and shrink strands the index past the end (making `k` appear dead). Anchoring
 * on `runNodeKey` keeps the same node focused across live mutations; when the
 * anchored node disappears, fall back to the last known index clamped in range
 * so navigation responds immediately.
 */
export function resolveFocusIdx(
  flat: ReadonlyArray<FlatNode>,
  selectedKey: string | null,
  lastIdx: number,
): number {
  if (selectedKey !== null) {
    const idx = flat.findIndex((f) => runNodeKey(f.node) === selectedKey);
    if (idx >= 0) return idx;
  }
  if (flat.length === 0) return 0;
  return Math.min(Math.max(lastIdx, 0), flat.length - 1);
}

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

  function walk(n: GatewayRunNode, depth: number, visiting: Set<string>) {
    const key = runNodeKey(n);
    if (visiting.has(key)) return;
    visiting.add(key);
    const childIds = n.childIds ?? [];
    const hasChildren = childIds.length > 0;
    const isCollapsed = collapsed.has(key);
    result.push({ node: n, depth, hasChildren, isCollapsed });
    if (!isCollapsed && hasChildren) {
      for (const childId of childIds) {
        const child = nodeMap.get(childId);
        if (child) walk(child, depth + 1, visiting);
      }
    }
    visiting.delete(key);
  }

  walk(root, 0, new Set());
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
  // Completed leaf nodes open on their output. Keyed on status because real
  // gateway tree rows never carry `output` inline (the output arrives via the
  // getNodeOutput RPC) — the `node.output` check alone was dead in production.
  if (status === "done" || status === "completed" || status === "ok") return "output";
  if (node.output) return "output";
  return "props";
}
