// Shared dark token bridge for the 23 legacy workflow UIs in this directory.
//
// Most of these UIs already render WorkflowUiStyles after their local sheet.
// Keep that shipped component as the source of global element/control styles;
// this module only supplies the legacy palette aliases and the few layout rules
// that WorkflowUiStyles does not provide.

/**
 * The canonical names match cw-theme.ts. Legacy names remain aliases so the
 * existing UI-specific rules keep their original rendered colors.
 */
export const sharedDarkTokensCss =
  ":root { color-scheme:dark; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
  " --bg:#0c0c0e; --text:#eee; --text-muted:#8a8a8e; --text-faint:#8a8a8e; --text-placeholder:#8a8a8e;" +
  " --surface:#151518; --surface-2:#1c1c1f; --surface-glass:rgba(21,21,24,0.72); --surface-glass-strong:rgba(21,21,24,0.85);" +
  " --border:#262629; --border-strong:#262629; --border-solid:#262629; --hover:#1c1c1f; --hover-subtle:rgba(255,255,255,0.03);" +
  " --inverse-bg:#eee; --inverse-text:#0c0c0e; --code-bg:#0c0c0e; --code-text:#eee; --inline-code-bg:#1c1c1f;" +
  " --brand:#5e6ad2; --success:#4ade80; --danger:#f87171; --warning:#fbbf24; --info:#60a5fa; --shadow-rgb:0 0 0;" +
  " --graph-bg:#0c0c0e; --graph-border:#262629; --graph-dots:#262629;" +
  " --node-bg:#151518; --node-border:#262629; --node-title:#eee; --node-muted:#8a8a8e; --node-shadow:rgb(0 0 0 / 45%);" +
  " --panel:var(--surface); --card:var(--surface-2); --line:var(--border-solid); --muted:var(--text-muted);" +
  " --primary:var(--brand); --ok:var(--success); --warn:var(--warning); --err:var(--danger); --bad:var(--danger); --blue:var(--brand); }";

/** Mirrors the global policy in packages/ui/src/uiCss.ts. */
export const sharedDarkReducedMotionCss =
  "@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-delay:0ms !important;" +
  " animation-duration:0.001ms !important; animation-iteration-count:1 !important; scroll-behavior:auto !important;" +
  " transition-delay:0ms !important; transition-duration:0.001ms !important; } }";

/** Layout rules used by the component-backed UIs but not shipped by WorkflowUiStyles. */
export const sharedDarkLegacyLayoutCss = [
  ".shell { height:100vh; display:flex; flex-direction:column; overflow:hidden; }",
  ".content { padding:20px; overflow:auto; }",
  ".sidebar { border-left:1px solid var(--border); background:var(--panel); overflow:auto; }",
  ".side-head { padding:12px 16px; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); border-bottom:1px solid var(--border); }",
  ".run-row .mono { font-family:ui-monospace,monospace; font-size:11px; }",
];

/**
 * Theme fragment for UIs that also render WorkflowUiStyles. The shipped
 * component owns reset, typography, topbar, button, pill, badge, and status
 * rules, so they are intentionally not duplicated here.
 */
export const sharedDarkThemeCss: string[] = [
  sharedDarkTokensCss,
  ...sharedDarkLegacyLayoutCss,
  sharedDarkReducedMotionCss,
];

/**
 * The two standalone UIs do not render WorkflowUiStyles. Their original
 * reset/body rules stay here so extraction does not change their appearance.
 */
export const sharedDarkStandaloneThemeCss: string[] = [
  sharedDarkTokensCss,
  "* { box-sizing:border-box; }",
  "body { margin:0; background:var(--bg); color:var(--text); font-size:13px; line-height:1.5; }",
  sharedDarkReducedMotionCss,
];
