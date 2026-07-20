import type { NodeStatus } from "./Run";

/**
 * One source of truth for how a status reads and colors. `tone` maps to a CSS
 * custom property so light/dark both resolve correctly (see styles.css). Color
 * is state, never decoration.
 */
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
