/**
 * One source of truth for how a run/node status reads and colors, ported from
 * multi's `src/runs/statusMeta.ts` (`research/tui-parity/01-packages.md`
 * phase 2). multi's `src/runs/statusMeta.ts` now re-exports this module
 * verbatim, so `tone` — a display-only classification, never the raw status
 * string — colors the same status identically on both platforms.
 */
export type NodeStatus = "ok" | "running" | "queued" | "failed" | "waiting" | "cancelled" | "unknown";

export type StatusTone = "running" | "ok" | "waiting" | "failed" | "idle";

const META: Record<NodeStatus, { tone: StatusTone; label: string }> = {
  running: { tone: "running", label: "running" },
  ok: { tone: "ok", label: "ok" },
  queued: { tone: "idle", label: "queued" },
  waiting: { tone: "waiting", label: "waiting" },
  failed: { tone: "failed", label: "failed" },
  // Terminal but NOT a failure: a deliberate cancel reads neutral (idle tone),
  // never as an error and never as "queued" (not started) — mirrors
  // treeUtils.nodeGlyph/nodeGlyphColor's cancelled convention.
  cancelled: { tone: "idle", label: "cancelled" },
  // Unrecognized wire value: neutral, not "queued" — the run may well have
  // started; we simply don't know its lifecycle state.
  unknown: { tone: "idle", label: "unknown" },
};

export function statusTone(status: NodeStatus): StatusTone {
  return META[status].tone;
}

export function statusLabel(status: NodeStatus): string {
  return META[status].label;
}
