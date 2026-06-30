/**
 * Shared style tokens for the gateway UI components. Inline-style based on
 * purpose: a custom workflow UI under `.smithers/ui/<workflow>.tsx` is bundled
 * by the gateway's `Bun.build` (no CSS loader), so these components carry their
 * own styling as plain `React.CSSProperties` objects — no `.css` import needed.
 *
 * The palette is a dark, neutral console theme. Override per-component with the
 * `style`/`className` props every component accepts.
 */
export const theme = {
  bg: "#0f1115",
  panel: "#171a21",
  panelAlt: "#1d212b",
  border: "#272b36",
  text: "#e6e9ef",
  textDim: "#9aa3b2",
  accent: "#4a78ff",
  radius: 8,
  fontMono:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  fontSans:
    'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
} as const;

/** Status → accent color, shared by StatusPill and the run/node lists. */
export const statusColors: Record<string, string> = {
  ok: "#3fb950",
  done: "#3fb950",
  completed: "#3fb950",
  running: "#4a78ff",
  queued: "#9aa3b2",
  pending: "#d29922",
  waiting: "#d29922",
  "waiting-approval": "#d29922",
  paused: "#d29922",
  failed: "#f85149",
  error: "#f85149",
  cancelled: "#8b949e",
  canceled: "#8b949e",
};

/** The accent color for a status string, defaulting to the dim neutral. */
export function statusColor(status: string | undefined): string {
  if (!status) return theme.textDim;
  return statusColors[status.toLowerCase()] ?? theme.textDim;
}
