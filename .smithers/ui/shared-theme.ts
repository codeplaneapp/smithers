// Shared dark mini-theme for the local workflow UIs.
//
// 23 UIs in this directory each shipped a byte-identical inline copy of the
// same dark token block plus the same handful of shell/topbar/button/badge
// rules. That copy now lives here once, composed the same way cw-theme.ts
// composes its sheet: the shipped gateway-ui styleguide first, then the token
// block, then only the rules the styleguide does not already cover.
//
// Usage: spread it at the head of a UI's own `styles` array so the UI's local
// overrides still come last and win.
//
//   const styles = [...sharedDarkThemeCss, ".my-rule { ... }"];
import { workflowUiThemeCss } from "smithers-orchestrator/gateway-ui";

/**
 * Dark palette for these UIs. The legacy names (`--panel`, `--card`,
 * `--primary`, `--ok`, `--err`, `--warn`) keep their original values so the
 * rendered result is unchanged, and each is paired with the canonical
 * cw-theme.ts / ui-styleguide name (`--surface`, `--brand`, `--success`,
 * `--danger`, `--warning`, ...) set to the same value, so styleguide rules and
 * local rules resolve to one palette.
 */
export const sharedDarkTokensCss =
  ":root { --bg:#0c0c0e; --panel:#151518; --card:#1c1c1f; --text:#eee; --muted:#8a8a8e; --border:#262629;" +
  " --primary:#5e6ad2; --ok:#4ade80; --err:#f87171; --warn:#fbbf24;" +
  " --surface:#151518; --surface-2:#1c1c1f; --border-solid:#262629; --line:#262629; --hover:#1c1c1f;" +
  " --text-muted:#8a8a8e; --brand:#5e6ad2; --success:#4ade80; --danger:#f87171; --warning:#fbbf24; --info:#60a5fa;" +
  " color-scheme:dark; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }";

/**
 * Global motion clamp, mirroring `reducedMotionCss` in
 * packages/ui/src/uiCss.ts so a locally declared transition or keyframe in one
 * of these UIs honors the same policy as the shipped components.
 */
export const sharedDarkReducedMotionCss =
  "@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-delay:0ms !important;" +
  " animation-duration:0.001ms !important; animation-iteration-count:1 !important; scroll-behavior:auto !important;" +
  " transition-delay:0ms !important; transition-duration:0.001ms !important; } }";

/** The rules these UIs share that the styleguide sheet does not cover. */
export const sharedDarkBaseCss = [
  "* { box-sizing:border-box; }",
  "body { margin:0; background:var(--bg); color:var(--text); font-size:13px; line-height:1.5; }",
  "button,input { font:inherit; }",
  ".shell { height:100vh; display:flex; flex-direction:column; overflow:hidden; }",
  ".topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 20px; border-bottom:1px solid var(--border); }",
  ".title-group { display:flex; align-items:center; gap:12px; min-width:0; }",
  "h1 { margin:0; font-size:14px; font-weight:600; }",
  ".pill { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); background:var(--panel); padding:4px 10px; border-radius:6px; border:1px solid var(--border); }",
  ".button { height:30px; padding:0 12px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); cursor:pointer; font-weight:500; }",
  ".button:hover { background:var(--card); }",
  ".button.primary { background:var(--primary); color:#fff; border-color:var(--primary); }",
  ".button.danger { color:var(--err); }",
  ".button:disabled { opacity:0.4; cursor:not-allowed; }",
  ".content { padding:20px; overflow:auto; }",
  ".badge { font-size:11px; font-weight:600; text-transform:uppercase; padding:3px 8px; border-radius:5px; border:1px solid var(--border); }",
  ".badge.running { color:var(--warn); border-color:var(--warn); }",
  ".badge.finished { color:var(--ok); border-color:var(--ok); }",
  ".badge.failed { color:var(--err); border-color:var(--err); }",
  ".empty { color:var(--muted); text-align:center; padding:48px 16px; }",
  ".sidebar { border-left:1px solid var(--border); background:var(--panel); overflow:auto; }",
  ".side-head { padding:12px 16px; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); border-bottom:1px solid var(--border); }",
  ".run-row:hover { background:var(--card); }",
  ".run-row.active { background:var(--card); box-shadow:inset 2px 0 0 var(--primary); }",
  ".run-row .mono { font-family:ui-monospace,monospace; font-size:11px; }",
];

/** Spread this at the head of a UI's `styles` array. */
export const sharedDarkThemeCss: string[] = [
  workflowUiThemeCss,
  sharedDarkTokensCss,
  ...sharedDarkBaseCss,
  sharedDarkReducedMotionCss,
];
