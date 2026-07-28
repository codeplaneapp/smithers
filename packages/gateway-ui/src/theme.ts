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
import type { CSSProperties } from "react";
import { reducedMotionCss } from "@smithers-orchestrator/ui-styleguide";

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
  warning: "var(--warning, #916000)",
  warningSoft: "var(--warning-soft, color-mix(in srgb, var(--warning, #916000) 12%, var(--surface, #ffffff)))",
  warningBorder: "var(--warning-border, color-mix(in srgb, var(--warning, #916000) 40%, transparent))",
  info: "var(--info, #2a63c9)",
  infoSoft: "var(--info-soft, color-mix(in srgb, var(--info, #2a63c9) 10%, var(--surface, #ffffff)))",
  infoBorder: "var(--info-border, color-mix(in srgb, var(--info, #2a63c9) 40%, transparent))",
  neutralSoft: "var(--hover-subtle, rgba(24,24,27,0.04))",
  neutralBorder: "var(--border, rgba(24,24,27,0.08))",
  ring: "var(--ring, color-mix(in srgb, var(--brand, #6d56d8) 22%, transparent))",
  ringBorder: "var(--ring-border, color-mix(in srgb, var(--brand, #6d56d8) 50%, transparent))",
  radius: "var(--r-2, 10px)",
  // The canonical house stacks, routed through the styleguide custom
  // properties (identical fallbacks in ui-styleguide and @smithers-orchestrator/ui
  // tokens -- keep all three in sync).
  fontMono: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)",
  fontSans:
    "var(--font-sans, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif)",
} as const;

export const GATEWAY_UI_STYLE_ATTR = "data-smithers-gateway-ui";

/** Screen-reader-only inline styles, mirroring the styleguide `.sui-sr-only` rule. */
export const visuallyHidden: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

/** Class rules for states inline styles cannot express (focus/hover/tone). */
export const gatewayUiCss = `
.gw-launch-button { cursor:pointer; transition:background-color .12s ease, border-color .12s ease, color .12s ease; }
.gw-launch-button:hover:not(:disabled) { background:color-mix(in srgb, ${theme.accent} 85%, ${theme.text}); }
.gw-launch-button:active:not(:disabled) { background:color-mix(in srgb, ${theme.accent} 72%, ${theme.text}); }
.gw-launch-button:disabled { cursor:wait; opacity:.6; }
.gw-launch-button:focus-visible { outline:none; box-shadow:0 0 0 3px ${theme.ring}; }
.gw-fleet-row:focus-visible { outline:none; box-shadow:inset 2px 0 0 ${theme.accent}, inset 0 0 0 3px ${theme.ring}; }
.gw-node-row { display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%; padding:6px 8px 6px calc(8px + var(--gw-node-depth, 0) * 16px); border:1px solid transparent; border-left-width:2px; background:transparent; color:${theme.text}; cursor:pointer; text-align:left; font-family:${theme.fontSans}; font-size:13px; transition:background-color .12s ease, border-color .12s ease, color .12s ease; }
.gw-node-row[data-interactive='false'] { cursor:default; }
.gw-node-row:hover { background:${theme.panelAlt}; }
.gw-node-row[data-active='true'] { border-left-color:${theme.accent}; background:${theme.accentSoft}; }
.gw-run-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 10px; border-radius:${theme.radius}; border:1px solid ${theme.border}; background:${theme.panel}; color:${theme.text}; cursor:pointer; text-align:left; transition:background-color .12s ease, border-color .12s ease, color .12s ease; }
.gw-run-row:hover { background:${theme.panelAlt}; }
.gw-run-row:active,.gw-node-row:active { background:color-mix(in srgb, ${theme.text} 6%, ${theme.panelAlt}); }
.gw-run-row[data-active='true'] { border-color:${theme.accentBorder}; background:${theme.accentSoft}; }
.gw-approval-button { padding:6px 14px; border-radius:6px; border:1px solid var(--gw-tone-border); background:var(--gw-tone-soft); color:var(--gw-tone); font:inherit; font-size:13px; font-weight:650; cursor:pointer; transition:background-color .12s ease, border-color .12s ease, color .12s ease; }
.gw-approval-button:hover:not(:disabled) { background:color-mix(in srgb, var(--gw-tone) 16%, ${theme.panel}); }
.gw-approval-button:active:not(:disabled) { background:color-mix(in srgb, var(--gw-tone) 18%, ${theme.panel}); }
.gw-approval-button-success { --gw-tone:${theme.success}; --gw-tone-soft:${theme.successSoft}; --gw-tone-border:${theme.successBorder}; }
.gw-approval-button-danger { --gw-tone:${theme.danger}; --gw-tone-soft:${theme.dangerSoft}; --gw-tone-border:${theme.dangerBorder}; }
.gw-approval-button-neutral { --gw-tone:${theme.textDim}; --gw-tone-soft:${theme.panelAlt}; --gw-tone-border:${theme.border}; }
.gw-approval-button:disabled { cursor:not-allowed; opacity:.6; }
.gw-node-row:focus-visible,.gw-run-row:focus-visible,.gw-approval-button:focus-visible { outline:none; border-color:${theme.ringBorder}; box-shadow:0 0 0 3px ${theme.ring}; }
.gw-status-pill { --gw-tone:${theme.textDim}; --gw-tone-soft:${theme.neutralSoft}; --gw-tone-border:${theme.neutralBorder}; display:inline-flex; align-items:center; gap:6px; padding:2px 8px; border-radius:999px; border:1px solid var(--gw-tone-border); background:var(--gw-tone-soft); color:var(--gw-tone); font-size:12px; font-weight:650; }
.gw-status-pill.run { --gw-tone:${theme.accent}; --gw-tone-soft:${theme.accentSoft}; --gw-tone-border:${theme.accentBorder}; }
.gw-status-pill.ok { --gw-tone:${theme.success}; --gw-tone-soft:${theme.successSoft}; --gw-tone-border:${theme.successBorder}; }
.gw-status-pill.warn { --gw-tone:${theme.warning}; --gw-tone-soft:${theme.warningSoft}; --gw-tone-border:${theme.warningBorder}; }
.gw-status-pill.bad { --gw-tone:${theme.danger}; --gw-tone-soft:${theme.dangerSoft}; --gw-tone-border:${theme.dangerBorder}; }
.gw-status-pill-dot { width:6px; height:6px; border-radius:999px; background:var(--gw-tone); }
.gw-node-output-card { --gw-tone:${theme.textDim}; --gw-tone-soft:${theme.neutralSoft}; }
.gw-node-output-card[data-status='produced'] { --gw-tone:${theme.success}; --gw-tone-soft:${theme.successSoft}; }
.gw-node-output-card[data-status='failed'] { --gw-tone:${theme.danger}; --gw-tone-soft:${theme.dangerSoft}; }
.gw-node-output-glyph { display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; border-radius:999px; flex-shrink:0; font-size:12px; font-weight:650; color:var(--gw-tone); background:var(--gw-tone-soft); }
.gw-event-log { display:flex; flex-direction:column; min-width:0; min-height:0; background:${theme.bg}; border:1px solid ${theme.border}; border-radius:${theme.radius}; color:${theme.text}; overflow:hidden; }
.gw-event-log-toolbar { display:flex; align-items:center; gap:8px; padding:6px 8px; border-bottom:1px solid ${theme.border}; }
.gw-event-log-toolbar-spacer { flex:1; }
.gw-event-log-count { color:${theme.textDim}; font-family:${theme.fontMono}; font-size:11px; }
.gw-event-rows { display:flex; flex-direction:column; gap:2px; overflow:auto; padding:6px; min-height:0; }
.gw-event-row { display:flex; flex-direction:column; border:1px solid transparent; border-left-width:2px; border-radius:6px; }
.gw-event-row[data-tone='failed'] { border-color:${theme.dangerBorder}; background:${theme.dangerSoft}; }
.gw-event-row[data-active='true'] { border-left-color:${theme.accent}; background:${theme.accentSoft}; }
.gw-event-row[data-heartbeat='true'] { opacity:.6; }
.gw-event-row-head { display:flex; align-items:center; gap:2px; width:100%; min-width:0; }
.gw-event-row-main { display:flex; align-items:center; gap:8px; min-width:0; flex:1; padding:4px 6px; background:transparent; border:none; color:${theme.text}; font-family:${theme.fontSans}; font-size:12px; text-align:left; cursor:default; }
.gw-event-row-main[data-selectable='true'] { cursor:pointer; border-radius:6px; }
.gw-event-row-main[data-selectable='true']:hover { background:${theme.panelAlt}; }
.gw-event-row-seq { color:${theme.textDim}; font-family:${theme.fontMono}; font-size:11px; flex-shrink:0; }
.gw-event-row-chip { font-family:${theme.fontMono}; font-size:11px; color:${theme.text}; background:${theme.neutralSoft}; border:1px solid ${theme.neutralBorder}; border-radius:5px; padding:1px 6px; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex-shrink:0; }
.gw-event-row-meta { color:${theme.textDim}; font-size:11px; flex-shrink:0; }
.gw-event-row-count { font-family:${theme.fontMono}; font-size:11px; color:${theme.textDim}; flex-shrink:0; }
.gw-event-row-summary { color:${theme.textDim}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; flex:1; }
.gw-event-row[data-tone='failed'] .gw-event-row-summary { color:${theme.danger}; font-weight:600; }
.gw-event-row-toggle { flex-shrink:0; margin-right:6px; padding:4px 8px; background:transparent; border:1px solid ${theme.border}; border-radius:5px; color:${theme.textDim}; font-family:${theme.fontMono}; font-size:11px; cursor:pointer; }
.gw-event-row-toggle:hover { background:${theme.panelAlt}; }
.gw-event-row-json { margin:0 8px 8px 8px; padding:8px; background:${theme.panel}; border:1px solid ${theme.border}; border-radius:6px; font-family:${theme.fontMono}; font-size:11px; line-height:1.5; white-space:pre-wrap; word-break:break-word; overflow:auto; max-height:280px; color:${theme.text}; }
.gw-event-row-main:focus-visible,.gw-event-row-toggle:focus-visible { outline:none; border-color:${theme.ringBorder}; box-shadow:0 0 0 3px ${theme.ring}; }
.gw-event-log-body { position:relative; display:flex; flex-direction:column; flex:1 1 auto; min-height:0; }
.gw-event-jump { position:absolute; left:50%; bottom:14px; transform:translateX(-50%); z-index:5; display:inline-flex; align-items:center; gap:6px; padding:4px 12px; border:1px solid ${theme.border}; border-radius:999px; background:${theme.panel}; color:${theme.text}; font-family:${theme.fontSans}; font-size:12px; cursor:pointer; box-shadow:0 1px 2px rgb(var(--shadow-rgb, 24 24 27) / 0.06), 0 8px 24px rgb(var(--shadow-rgb, 24 24 27) / 0.10); transition:background-color .12s ease, border-color .12s ease, color .12s ease; }
.gw-event-jump:hover { background:${theme.panelAlt}; }
.gw-event-jump:focus-visible { outline:none; border-color:${theme.ringBorder}; box-shadow:0 0 0 3px ${theme.ring}; }
.gw-canvas-node { border-left:3px solid var(--gw-kind, transparent); }
.gw-canvas-node[data-kind='agent'] { --gw-kind:${theme.accent}; }
.gw-canvas-node[data-kind='compute'] { --gw-kind:${theme.info}; }
.gw-canvas-node[data-kind='approval'] { --gw-kind:${theme.warning}; }
.gw-canvas-node[data-kind='merge'] { --gw-kind:${theme.success}; }
.gw-canvas-node[data-kind='loop'] { --gw-kind:${theme.info}; }
.gw-canvas-node[data-kind='branch'] { --gw-kind:${theme.warning}; }
.gw-canvas-node[data-kind='signal'] { --gw-kind:${theme.accent}; }
.gw-canvas-node[data-kind='human'] { --gw-kind:${theme.danger}; }
.gw-monitor-button { display:inline-flex; align-items:center; gap:6px; text-decoration:none; }
${reducedMotionCss}
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
