/** @jsxImportSource @opentui/react */

/**
 * The node-tree status vocabulary (gateway `GatewayRunNode.status` strings),
 * distinct from {@link StatusPill}'s coarser `TuiStatusTone`: a run tree needs
 * to distinguish queued/waiting/cancelled/failed with their own glyphs. Kept
 * as a local copy of ui-core's `nodeGlyph`/`nodeGlyphColor` tables (treeUtils),
 * not an import: leaf visual packages carry no cross-package coupling
 * (props-in/callbacks-out, no business logic).
 */

/** The glyph for a node status. Pure so it is testable without a TTY. */
export function nodeStatusGlyph(status: string): string {
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

/** The color for a node status. Pure so it is testable without a TTY. */
export function nodeStatusColor(status: string): string {
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

export type StatusGlyphProps = {
  status: string;
};

/** A node's status glyph, colored. Props-in/callbacks-out: no business logic. */
export function StatusGlyph({ status }: StatusGlyphProps) {
  return <text fg={nodeStatusColor(status)}>{nodeStatusGlyph(status)}</text>;
}
