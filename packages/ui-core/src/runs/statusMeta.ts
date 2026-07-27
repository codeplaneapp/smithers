/**
 * One source of truth for how a run/node status reads and colors, ported from
 * multi's `src/runs/statusMeta.ts` (`research/tui-parity/01-packages.md`
 * phase 2). multi's `src/runs/statusMeta.ts` now re-exports this module
 * verbatim, so `tone` — a display-only classification, never the raw status
 * string — colors the same status identically on both platforms.
 */
export type NodeStatus = "ok" | "running" | "queued" | "failed" | "waiting";

export type StatusTone = "running" | "ok" | "waiting" | "failed" | "idle";

const META: Record<NodeStatus, { tone: StatusTone; label: string }> = {
  running: { tone: "running", label: "running" },
  ok: { tone: "ok", label: "ok" },
  queued: { tone: "idle", label: "queued" },
  waiting: { tone: "waiting", label: "waiting" },
  failed: { tone: "failed", label: "failed" },
};

export function statusTone(status: NodeStatus): StatusTone {
  return META[status].tone;
}

export function statusLabel(status: NodeStatus): string {
  return META[status].label;
}
