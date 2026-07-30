/**
 * Shared terminal status vocabulary. Tone names mirror
 * `@smithers-orchestrator/ui`'s canonical `StatusClass`; terminal-safe hex
 * values mirror ui-core's node glyph palette.
 */
export type TuiStatusTone = "ok" | "warn" | "bad" | "muted" | "run";

const STATUS_TONE_COLORS: Readonly<Record<TuiStatusTone, string>> = {
  ok: "#00d787",
  warn: "#ffaf00",
  bad: "#ff5f5f",
  muted: "#888888",
  run: "#00d7ff",
};

/** The color for a canonical terminal status tone. */
export function statusToneColor(tone: TuiStatusTone): string {
  return STATUS_TONE_COLORS[tone];
}

/**
 * Local copies of ui-core's node glyph tables keep this props-only visual
 * package independent of ui-core's product/data dependency graph. Their
 * parity is pinned by tests/status-parity.test.ts.
 */
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

export function nodeStatusColor(status: string): string {
  switch (status) {
    case "done":
    case "completed":
    case "ok":
      return statusToneColor("ok");
    case "running":
    case "active":
      return statusToneColor("run");
    case "waiting":
    case "paused":
    case "blocked":
    case "waiting_approval":
      return statusToneColor("warn");
    case "cancelled":
    case "canceled":
      return statusToneColor("muted");
    case "failed":
    case "error":
      return statusToneColor("bad");
    default:
      return "#6c6c6c";
  }
}
