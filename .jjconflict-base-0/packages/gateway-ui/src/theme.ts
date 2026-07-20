/**
 * Shared style tokens for gateway UI components.
 *
 * Every color token is a `var(--token, #lightFallback)` expression rather than a
 * raw hex: when the workflow UI style guide (`WorkflowUiStyles` /
 * `workflowUiThemeCss`, which the gateway host page also injects) defines the
 * custom properties, inline styles resolve through them and follow the active
 * theme — OS `prefers-color-scheme` and an explicit `data-theme="dark|light"`
 * on `<html>` (settable via the host page's `?theme=` query param). Without the
 * style guide the fallbacks reproduce the exact light values, so components
 * still bundle standalone with no CSS loader.
 *
 * NOTE: because the values are `var()` expressions, never string-concatenate an
 * alpha suffix onto them — derive tints with
 * `color-mix(in srgb, ${token} N%, transparent)` instead.
 */
export const theme = {
  bg: "var(--bg, #fafafa)",
  panel: "var(--surface, #ffffff)",
  panelAlt: "var(--hover, #f4f4f5)",
  border: "var(--border-solid, #e4e4e7)",
  text: "var(--text, #18181b)",
  textDim: "var(--text-muted, #52525b)",
  accent: "var(--brand, #6d56d8)",
  success: "var(--success, #0f8f78)",
  danger: "var(--danger, #e5484d)",
  warning: "var(--warning, #bf7100)",
  info: "var(--info, #2f6fde)",
  radius: 10,
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
  continued: theme.success,
  complete: theme.success,
  completed: theme.success,
  closed: theme.success,
  running: theme.accent,
  queued: theme.textDim,
  pending: theme.textDim,
  waiting: theme.warning,
  "waiting-approval": theme.warning,
  "waiting-event": theme.warning,
  "waiting-timer": theme.warning,
  "waiting-quota": theme.warning,
  paused: theme.warning,
  open: theme.textDim,
  todo: theme.textDim,
  failed: theme.danger,
  failure: theme.danger,
  error: theme.danger,
  blocked: theme.danger,
  cancelled: theme.textDim,
  canceled: theme.textDim,
  skipped: theme.textDim,
};

// The status vocabulary (normalize/bucket/label + terminal detection) lives in
// @smithers-orchestrator/ui so every consumer shares ONE copy; these re-exports
// keep the long-standing gateway-ui import paths working unchanged.
export {
  normalizeStatus,
  statusClass,
  formatStatus,
  isTerminalRunStatus,
  type StatusClass,
} from "@smithers-orchestrator/ui";
import { normalizeStatus } from "@smithers-orchestrator/ui";

/** The accent color for a status string, defaulting to the dim neutral. */
export function statusColor(status: string | undefined): string {
  const normalized = normalizeStatus(status);
  if (!normalized) return theme.textDim;
  return statusColors[normalized] ?? theme.textDim;
}
