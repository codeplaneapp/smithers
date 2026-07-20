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
  accentSoft: "var(--brand-soft, color-mix(in srgb, var(--brand, #6d56d8) 10%, var(--surface, #ffffff)))",
  accentBorder: "var(--brand-border, color-mix(in srgb, var(--brand, #6d56d8) 40%, transparent))",
  success: "var(--success, #087461)",
  successSoft: "var(--success-soft, color-mix(in srgb, var(--success, #087461) 12%, var(--surface, #ffffff)))",
  successBorder: "var(--success-border, color-mix(in srgb, var(--success, #087461) 40%, transparent))",
  danger: "var(--danger, #c5343f)",
  dangerSoft: "var(--danger-soft, color-mix(in srgb, var(--danger, #c5343f) 10%, var(--surface, #ffffff)))",
  dangerBorder: "var(--danger-border, color-mix(in srgb, var(--danger, #c5343f) 40%, transparent))",
  warning: "var(--warning, #955600)",
  warningSoft: "var(--warning-soft, color-mix(in srgb, var(--warning, #955600) 12%, var(--surface, #ffffff)))",
  warningBorder: "var(--warning-border, color-mix(in srgb, var(--warning, #955600) 40%, transparent))",
  info: "var(--info, #2f6fde)",
  infoSoft: "var(--info-soft, color-mix(in srgb, var(--info, #2f6fde) 10%, var(--surface, #ffffff)))",
  infoBorder: "var(--info-border, color-mix(in srgb, var(--info, #2f6fde) 40%, transparent))",
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
