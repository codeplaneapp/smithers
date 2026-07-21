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
  neutralSoft: "var(--hover-subtle, rgba(24,24,27,0.04))",
  neutralBorder: "var(--border, rgba(24,24,27,0.08))",
  ring: "var(--ring, color-mix(in srgb, var(--brand, #6d56d8) 22%, transparent))",
  ringBorder: "var(--ring-border, color-mix(in srgb, var(--brand, #6d56d8) 50%, transparent))",
  radius: "var(--r-2, 10px)",
  fontMono:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  fontSans:
    'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
} as const;

export const GATEWAY_UI_STYLE_ATTR = "data-smithers-gateway-ui";

/** Class rules for states inline styles cannot express (focus/hover/tone). */
export const gatewayUiCss = `
.gw-node-row { display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%; padding:6px 8px 6px calc(8px + var(--gw-node-depth, 0) * 16px); border:1px solid transparent; border-left-width:2px; background:transparent; color:${theme.text}; cursor:pointer; text-align:left; font-family:${theme.fontSans}; font-size:13px; }
.gw-node-row[data-interactive='false'] { cursor:default; }
.gw-node-row:hover { background:${theme.panelAlt}; }
.gw-node-row[data-active='true'] { border-left-color:${theme.accent}; background:${theme.accentSoft}; }
.gw-run-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 10px; border-radius:${theme.radius}; border:1px solid ${theme.border}; background:${theme.panel}; color:${theme.text}; cursor:pointer; text-align:left; }
.gw-run-row:hover { background:${theme.panelAlt}; }
.gw-run-row[data-active='true'] { border-color:${theme.accentBorder}; background:${theme.accentSoft}; }
.gw-approval-button { padding:6px 14px; border-radius:6px; border:1px solid var(--gw-tone-border); background:var(--gw-tone-soft); color:var(--gw-tone); font:inherit; font-size:13px; font-weight:600; cursor:pointer; }
.gw-approval-button-success { --gw-tone:${theme.success}; --gw-tone-soft:${theme.successSoft}; --gw-tone-border:${theme.successBorder}; }
.gw-approval-button-danger { --gw-tone:${theme.danger}; --gw-tone-soft:${theme.dangerSoft}; --gw-tone-border:${theme.dangerBorder}; }
.gw-approval-button:disabled { cursor:not-allowed; opacity:.6; }
.gw-node-row:focus-visible,.gw-run-row:focus-visible,.gw-approval-button:focus-visible { outline:none; border-color:${theme.ringBorder}; box-shadow:0 0 0 3px ${theme.ring}; }
.gw-status-pill { --gw-tone:${theme.textDim}; --gw-tone-soft:${theme.neutralSoft}; --gw-tone-border:${theme.neutralBorder}; display:inline-flex; align-items:center; gap:6px; padding:2px 8px; border-radius:999px; border:1px solid var(--gw-tone-border); background:var(--gw-tone-soft); color:var(--gw-tone); font-size:12px; font-weight:600; }
.gw-status-pill.run { --gw-tone:${theme.accent}; --gw-tone-soft:${theme.accentSoft}; --gw-tone-border:${theme.accentBorder}; }
.gw-status-pill.ok { --gw-tone:${theme.success}; --gw-tone-soft:${theme.successSoft}; --gw-tone-border:${theme.successBorder}; }
.gw-status-pill.warn { --gw-tone:${theme.warning}; --gw-tone-soft:${theme.warningSoft}; --gw-tone-border:${theme.warningBorder}; }
.gw-status-pill.bad { --gw-tone:${theme.danger}; --gw-tone-soft:${theme.dangerSoft}; --gw-tone-border:${theme.dangerBorder}; }
.gw-status-pill-dot { width:6px; height:6px; border-radius:999px; background:var(--gw-tone); }
.gw-node-output-card { --gw-tone:${theme.textDim}; --gw-tone-soft:${theme.neutralSoft}; }
.gw-node-output-card[data-status='produced'] { --gw-tone:${theme.success}; --gw-tone-soft:${theme.successSoft}; }
.gw-node-output-card[data-status='failed'] { --gw-tone:${theme.danger}; --gw-tone-soft:${theme.dangerSoft}; }
.gw-node-output-glyph { display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; border-radius:999px; flex-shrink:0; font-size:12px; font-weight:700; color:var(--gw-tone); background:var(--gw-tone-soft); }
`;

export function ensureGatewayUiStyles(): void {
  if (typeof document === "undefined" || document.querySelector(`style[${GATEWAY_UI_STYLE_ATTR}]`)) return;
  const style = document.createElement("style");
  style.setAttribute(GATEWAY_UI_STYLE_ATTR, "");
  style.textContent = gatewayUiCss;
  document.head.appendChild(style);
}

// The complete status vocabulary, class colors, and resolver live in
// @smithers-orchestrator/ui. Re-export them so long-standing gateway-ui imports
// keep working without a second alias/color map.
export {
  resolveTheme,
  subscribeTheme,
  normalizeStatus,
  statusClass,
  statusColor,
  statusColors,
  formatStatus,
  isTerminalRunStatus,
  type ResolvedTheme,
  type StatusClass,
} from "@smithers-orchestrator/ui";
