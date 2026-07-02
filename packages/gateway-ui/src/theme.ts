/**
 * Shared style tokens for gateway UI components.
 *
 * The values mirror the Multi app style guide: light by default, OS dark mode,
 * neutral surfaces, soft borders, restrained purple brand accent, and semantic
 * status colors. Components still carry inline fallback styles so they bundle in
 * custom workflow UIs with no CSS loader, while `WorkflowUiStyles` exposes the
 * full class-based style guide for richer screens.
 */
export const theme = {
  bg: "#ffffff",
  panel: "#ffffff",
  panelAlt: "#f4f4f4",
  border: "#ededed",
  text: "#0a0a0a",
  textDim: "#525252",
  accent: "#6d56d8",
  success: "#0f8f78",
  danger: "#e5484d",
  warning: "#bf7100",
  radius: 8,
  fontMono:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  fontSans:
    'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
} as const;

/** Status → accent color, shared by StatusPill and the run/node lists. */
export const statusColors: Record<string, string> = {
  ok: theme.success,
  success: theme.success,
  done: theme.success,
  finished: theme.success,
  complete: theme.success,
  completed: theme.success,
  closed: theme.success,
  running: theme.warning,
  queued: theme.warning,
  pending: theme.warning,
  waiting: theme.warning,
  "waiting-approval": theme.warning,
  "waiting-event": theme.warning,
  "waiting-timer": theme.warning,
  paused: theme.warning,
  open: theme.warning,
  todo: theme.warning,
  failed: theme.danger,
  failure: theme.danger,
  error: theme.danger,
  blocked: theme.danger,
  cancelled: theme.textDim,
  canceled: theme.textDim,
  skipped: theme.textDim,
};

export function normalizeStatus(status: string | undefined): string {
  return (status ?? "").trim().toLowerCase().replaceAll("_", "-");
}

export function statusClass(status: string | undefined): "ok" | "warn" | "bad" | "muted" {
  const normalized = normalizeStatus(status);
  if (["fixed", "ready", "done", "finished", "success", "ok", "complete", "completed", "closed"].includes(normalized)) return "ok";
  if (["broken", "blocked", "failed", "failure", "error"].includes(normalized)) return "bad";
  if (
    ["partial", "missing-tests", "missing", "running", "pending", "queued", "waiting", "todo", "open"].includes(normalized) ||
    normalized.startsWith("waiting-")
  ) return "warn";
  return "muted";
}

export function formatStatus(status: string | undefined): string {
  const normalized = normalizeStatus(status);
  if (!normalized) return "Unknown";
  const labels: Record<string, string> = {
    ok: "Complete",
    success: "Complete",
    complete: "Complete",
    completed: "Complete",
    fixed: "Fixed",
    ready: "Ready",
    done: "Done",
    finished: "Finished",
    running: "Running",
    pending: "Pending",
    queued: "Queued",
    waiting: "Waiting",
    "waiting-approval": "Waiting for approval",
    "waiting-event": "Waiting for event",
    "waiting-timer": "Waiting on timer",
    partial: "Partial",
    "missing-tests": "Missing e2e",
    missing: "Missing",
    broken: "Broken",
    blocked: "Blocked",
    failed: "Failed",
    failure: "Failed",
    error: "Error",
    cancelled: "Cancelled",
    canceled: "Cancelled",
    skipped: "Skipped",
    todo: "Todo",
    open: "Open",
    closed: "Closed",
  };
  return labels[normalized] ?? normalized.split("-").map((part) => part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part).join(" ");
}

/** The accent color for a status string, defaulting to the dim neutral. */
export function statusColor(status: string | undefined): string {
  const normalized = normalizeStatus(status);
  if (!normalized) return theme.textDim;
  return statusColors[normalized] ?? theme.textDim;
}
