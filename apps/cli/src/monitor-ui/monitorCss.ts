// ---------------------------------------------------------------------------
// Styles. Token-first on top of the shared workflow-UI theme (light by
// default, OS dark mode, `data-theme` override) — every color is a theme
// variable or a color-mix tint of one; tones carry state, never decoration.
//
// Controls (buttons, chips, inputs, selects, row buttons, tables) are the
// shared smithers-orchestrator/ui primitives rendered by SmithersUiStyles at
// the root — their geometry, hover, focus-ring, and disabled styling live in
// that package, never here. This sheet only carries monitor layout plus
// monitor-specific accents on those primitives (.mon-btn-ok, .mon-toggle).
// Geometry for the rest comes from the token scales below: spacing --sp-*,
// type --fs-*/--lh-*, radius --r-*. No bare pixel values in spacing/radius/
// font-size rules.
// ---------------------------------------------------------------------------

export const monitorCss = `
:root {
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-6: 24px;
  --fs-1: 11px; --fs-2: 12px; --fs-3: 13px; --fs-4: 15px;
  --lh-tight: 1.35; --lh-body: 1.5;
  --r-1: 6px; --r-2: 9px; --r-3: 12px; --r-full: 999px;
  --ctl-h: 28px;
  --panel-pad: var(--sp-4);
}

* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-size: var(--fs-3); line-height: var(--lh-body); }
button, input, select { font: inherit; color: inherit; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--fs-2); background: var(--panel); border: 1px solid var(--border); border-radius: var(--r-1); padding: 0 var(--sp-1); }

.tone-running { --tone: var(--brand); }
.tone-ok { --tone: var(--ok); }
.tone-waiting { --tone: var(--warn); }
.tone-failed { --tone: var(--err); }
.tone-idle { --tone: var(--muted); }

.mon-shell { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
.mon-topbar { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.mon-brand { display: flex; align-items: center; gap: var(--sp-2); }
.mon-brand h1 { margin: 0; font-size: var(--fs-3); font-weight: 700; letter-spacing: -0.01em; }
.mon-brand-mark { width: 10px; height: 10px; border-radius: var(--r-full); background: var(--brand); }
.mon-conn { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-1); font-weight: 600; color: var(--tone); }
.mon-conn-hint { color: var(--muted); font-weight: 400; }
.mon-conn .mon-chip { height: 20px; padding: 0 var(--sp-2); border-radius: var(--r-full); margin-left: var(--sp-1); }
.mon-toolbar { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.mon-count-note { font-size: var(--fs-1); font-variant-numeric: tabular-nums; }

/* Controls are the shared smithers-orchestrator/ui primitives (sui-*): Button,
   Input, Select, RowButton carry their own geometry, hover, focus ring, and
   disabled styling. Only monitor-specific accents live here. */
.mon-filter-input { min-width: 200px; }
.mon-btn-ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--border)); }
.mon-toggle { color: var(--muted); font-size: var(--fs-1); font-weight: 600; }
.mon-toggle.is-on { color: var(--brand); border-color: color-mix(in srgb, var(--brand) 40%, var(--border)); }

/* Non-interactive label chips (agent names, #iteration, score chips). */
.mon-chip { display: inline-flex; align-items: center; gap: var(--sp-1); height: 20px; padding: 0 var(--sp-2); border-radius: var(--r-full); font-size: var(--fs-1); font-weight: 600; border: 1px solid var(--border); background: var(--surface); color: var(--muted); white-space: nowrap; }

.mon-kicker { margin: 0; font-size: var(--fs-1); line-height: var(--lh-tight); font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.mon-kicker-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
.mon-child-rollup { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-3); }
.mon-child-stat { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-1); }
.mon-container-note { font-size: var(--fs-1); }
.mon-hijack-inline { flex: none; }
.mon-tree-xml { font-family: var(--mono, ui-monospace, monospace); }
.mon-xml-row { display: flex; align-items: baseline; gap: 2px; line-height: 1.7; }
.mon-xml-row.is-active { background: color-mix(in srgb, var(--brand) 12%, transparent); border-radius: var(--r-1); }
.mon-xml-open { display: inline; border: 0; background: none; padding: 0; margin: 0; cursor: pointer; font: inherit; text-align: left; color: inherit; }
.mon-xml-open:hover .mon-xml-tag { text-decoration: underline; }
.mon-xml-punct { color: var(--dim); }
.mon-xml-tag { color: var(--brand); }
.mon-xml-attr-name { color: var(--muted); }
.mon-xml-str { color: var(--ok); }
.mon-xml-status { color: var(--tone, var(--ok)); }
.mon-xml-ellipsis { color: var(--muted); padding: 0 2px; }
.mon-count { font-variant-numeric: tabular-nums; color: var(--text); }
.mon-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--fs-1); }
.mon-dim { color: var(--muted); }

.mon-dot { width: 8px; height: 8px; border-radius: var(--r-full); background: var(--tone, var(--muted)); flex: none; }
.mon-dot-pulse { animation: mon-pulse 1.2s ease-in-out infinite; }
.mon-pill { display: inline-flex; align-items: center; gap: var(--sp-1); height: 20px; padding: 0 var(--sp-2); border-radius: var(--r-full); font-size: var(--fs-1); font-weight: 600; color: var(--tone); background: color-mix(in srgb, var(--tone) 10%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 30%, transparent); white-space: nowrap; }

/* Banners (app-level, health strip, inline errors) share one geometry. */
.mon-banner { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); margin: 0 0 var(--sp-4); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-2); font-weight: 600; font-size: var(--fs-2); color: var(--tone); background: color-mix(in srgb, var(--tone) 8%, var(--surface)); border: 1px solid color-mix(in srgb, var(--tone) 30%, var(--border)); animation: mon-in 140ms ease-out; }
.mon-banner-app { margin: var(--sp-2) var(--sp-4) 0; }

.mon-body { display: grid; grid-template-columns: 320px minmax(420px, 1fr) minmax(0, 380px); flex: 1; overflow: hidden; }
.mon-rail { border-right: 1px solid var(--border); overflow-y: auto; padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-4); }
.mon-main { overflow-y: auto; padding: var(--sp-4); }
.mon-embed .mon-body { display: block; }
.mon-embed .mon-main { height: 100%; padding: var(--sp-4); }
.mon-embed .mon-inspector { display: none; }
.mon-inspector { border-left: 1px solid var(--border); overflow-y: auto; padding: var(--panel-pad); animation: mon-in 140ms ease-out; }
@media (max-width: 1160px) {
  .mon-body { grid-template-columns: 300px 1fr; }
  .mon-inspector { position: fixed; right: 0; top: 0; bottom: 0; width: min(420px, 90vw); background: var(--bg); box-shadow: -12px 0 36px rgb(var(--shadow-rgb) / 0.14); z-index: 10; }
}

/* Phones trade the side-by-side rail for vertically stacked, independently
   scrollable panes. Keeping the shell itself clipped means wide tables and
   tree rows remain scrollable inside their owning panels instead of widening
   the document. */
@media (max-width: 720px) {
  .mon-topbar { align-items: flex-start; padding: var(--sp-3); }
  .mon-brand, .mon-toolbar { width: 100%; }
  .mon-toolbar { align-items: flex-start; }
  .mon-filter-input { flex: 1 1 100%; min-width: 0; }

  .mon-body { display: flex; flex-direction: column; min-height: 0; }
  .mon-rail { flex: 0 1 42%; min-height: 160px; border-right: 0; border-bottom: 1px solid var(--border); padding: var(--sp-3); }
  .mon-main { flex: 1 1 auto; min-width: 0; min-height: 0; padding: var(--sp-3); }

  .mon-panel-head, .mon-detail-actions, .mon-progress, .mon-scrub { flex-wrap: wrap; }
  .mon-metrics-grid { grid-template-columns: minmax(0, 1fr); }
  .mon-modal-backdrop { padding: var(--sp-3); }
  .mon-modal { width: min(1280px, 100%); height: min(860px, 100%); }
}

.mon-inbox { border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--border)); border-radius: var(--r-3); padding: var(--panel-pad); background: color-mix(in srgb, var(--warn) 5%, var(--surface)); animation: mon-in 140ms ease-out; }
.mon-inbox .mon-kicker { margin-bottom: var(--sp-1); }
.mon-approval { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-2) 0; border-top: 1px solid var(--border); }
.mon-approval:first-of-type { border-top: 0; }
.mon-approval:last-of-type { padding-bottom: 0; }
.mon-approval-main { text-align: left; background: none; border: 0; padding: 0; cursor: pointer; }
.mon-approval-title { font-weight: 600; }
.mon-approval-meta { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }
.mon-approval-summary { color: var(--muted); font-size: var(--fs-2); }
.mon-approval-actions { display: flex; gap: var(--sp-2); margin-top: var(--sp-1); }
.mon-wait { font-size: var(--fs-1); font-weight: 600; color: var(--tone); }

.mon-run-group { display: flex; flex-direction: column; gap: var(--sp-1); }
.mon-run-group .mon-kicker { padding: 0 var(--sp-1) var(--sp-1); }
/* Rail rows are shared RowButtons; only the internal layout is monitor-specific. */
.mon-run-row { justify-content: flex-start; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); }
.mon-run-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mon-run-when { margin-left: auto; font-size: var(--fs-1); font-variant-numeric: tabular-nums; white-space: nowrap; }

/* Landing runs table: fills the main column; the table body scrolls inside the
   panel (sticky header), never the page. */
.mon-runs-table-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; margin: 0; }
.mon-runs-table-panel .mon-panel-head { margin-bottom: var(--sp-2); }
.mon-runs-scroll { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--border); border-radius: var(--r-2); }
/* The shared Table wraps itself in an overflow-x container; inside the
   monitor's scrollports that inner scroller would defeat the sticky header,
   so let the outer .mon-*-scroll own all scrolling. */
.mon-runs-scroll [data-slot="table-container"], .mon-crons-scroll [data-slot="table-container"] { overflow-x: visible; }
.mon-runs-table { font-size: var(--fs-2); }
.mon-runs-table th { position: sticky; top: 0; z-index: 1; background: var(--surface); white-space: nowrap; }
.mon-runs-table td { white-space: nowrap; font-variant-numeric: tabular-nums; }
.mon-runs-table tbody tr:last-child td { border-bottom: 0; }
.mon-runs-table-row { cursor: pointer; }
.mon-table-workflow { font-weight: 600; max-width: 0; width: 40%; overflow: hidden; text-overflow: ellipsis; }
.mon-table-failed { color: var(--tone); font-weight: 600; }
.mon-runs-pagination { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); padding-top: var(--sp-3); flex-wrap: wrap; }
.mon-runs-pagination-controls { display: inline-flex; align-items: center; gap: var(--sp-2); }

/* All panels share one padding, radius, and stacking rhythm. */
.mon-panel { border: 1px solid var(--border); border-radius: var(--r-3); background: var(--surface); padding: var(--panel-pad); margin: 0 0 var(--sp-4); animation: mon-in 140ms ease-out; }
.mon-panel-head { display: flex; align-items: center; gap: var(--sp-2); min-height: var(--ctl-h); margin-bottom: var(--sp-3); }
.mon-panel-head .mon-kicker { margin-right: auto; }

.mon-detail-head { display: flex; flex-direction: column; gap: var(--sp-2); }
.mon-detail-header-band { margin-bottom: var(--sp-3); }
.mon-detail-cost-eta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
.mon-detail-title { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.mon-detail-workflow { font-weight: 700; font-size: var(--fs-4); line-height: var(--lh-tight); letter-spacing: -0.01em; }
.mon-detail-actions { display: flex; gap: var(--sp-2); }
.mon-runid { align-self: flex-start; background: none; border: 0; padding: 0; cursor: pointer; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--fs-1); color: var(--muted); }
.mon-runid:hover { color: var(--text); }
.mon-progress { display: flex; align-items: center; gap: var(--sp-2); }
.mon-progress-track { flex: 1; max-width: 320px; height: 5px; border-radius: var(--r-full); background: color-mix(in srgb, var(--brand) 12%, transparent); overflow: hidden; }
.mon-progress-fill { height: 100%; border-radius: var(--r-full); background: var(--brand); transition: width 300ms ease; }

.mon-tree { overflow-x: auto; }
.mon-tree-row { display: flex; align-items: center; border-radius: var(--r-1); }
.mon-tree-row:hover { background: var(--hover); }
.mon-tree-row.is-active { background: color-mix(in srgb, var(--brand) 9%, transparent); }
.mon-tree-chevron { width: 20px; flex: none; background: none; border: 0; cursor: pointer; color: var(--muted); text-align: center; }
.mon-tree-main { display: flex; align-items: center; gap: var(--sp-2); flex: 1; min-width: 0; text-align: left; background: none; border: 0; padding: var(--sp-1) var(--sp-2) var(--sp-1) 0; cursor: pointer; }
.mon-tree-glyph { flex: none; width: 14px; text-align: center; }
.mon-tree-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mon-tree-main .mon-pill { margin-left: auto; }
.mon-tree.is-static .mon-tree-main { cursor: default; }
.mon-tree.is-static { opacity: 0.92; }

/* Timeline: one row per (nodeId, iteration), chronological, click to inspect. */
.mon-timeline { display: flex; flex-direction: column; overflow-y: auto; max-height: 60vh; }
.mon-timeline-row { display: flex; align-items: center; gap: var(--sp-2); width: 100%; text-align: left; padding: var(--sp-1) var(--sp-2); border: 0; border-radius: var(--r-1); background: none; cursor: pointer; font-size: var(--fs-2); }
.mon-timeline-row:hover { background: var(--hover); }
.mon-timeline-row.is-active { background: color-mix(in srgb, var(--brand) 9%, transparent); box-shadow: inset 2px 0 0 var(--brand); }
.mon-timeline-node { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mon-timeline-row .mon-chip { flex: none; }
.mon-timeline-attempt { flex: none; }
.mon-timeline-right { display: flex; align-items: baseline; gap: var(--sp-3); margin-left: auto; flex: none; }
.mon-timeline-duration { font-variant-numeric: tabular-nums; }
.mon-timeline-when { font-size: var(--fs-1); font-variant-numeric: tabular-nums; min-width: 64px; text-align: right; }

/* Collapsed diff blocks: a one-line "N files, +X/−Y" summary; the syntax-
   colored diff view (@pierre/diffs) only mounts when expanded. */
.mon-diff { border: 1px solid var(--border); border-radius: var(--r-2); background: var(--panel); }
.mon-diff-summary { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); cursor: pointer; list-style: none; font-size: var(--fs-1); font-weight: 600; }
.mon-diff-summary::-webkit-details-marker { display: none; }
.mon-diff-summary:hover { background: var(--hover); border-radius: var(--r-2); }
.mon-diff-caret { color: var(--muted); transition: transform 120ms ease; }
.mon-diff[open] > .mon-diff-summary .mon-diff-caret { transform: rotate(90deg); }
.mon-diff[open] > .mon-diff-summary { border-bottom: 1px solid var(--border); border-radius: var(--r-2) var(--r-2) 0 0; }
.mon-diff-label { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mon-diff-stat { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.mon-diff-view { max-height: 50vh; overflow: auto; padding: var(--sp-1); }
.mon-diff-raw { border: 0; }
.mon-diff-raw-note { font-size: var(--fs-1); padding: var(--sp-2) var(--sp-2) 0; }

.mon-scrub { display: flex; align-items: center; gap: var(--sp-2); padding: 0 0 var(--sp-3); }
.mon-scrub-range { flex: 1; min-width: 120px; accent-color: var(--brand); }
.mon-scrub-range:disabled { opacity: 0.45; }
.mon-scrub-note { font-variant-numeric: tabular-nums; white-space: nowrap; }
.mon-scrub-loading { font-size: var(--fs-1); white-space: nowrap; animation: mon-pulse 1.2s ease-in-out infinite; }

.mon-events-panel { display: flex; flex-direction: column; }
.mon-events { max-height: 300px; overflow-y: auto; font-size: var(--fs-1); }
.mon-event { display: flex; gap: var(--sp-2); padding: var(--sp-1) 0; border-bottom: 1px solid var(--border); align-items: baseline; }
.mon-event:last-child { border-bottom: 0; }
.mon-event-name { font-weight: 600; white-space: nowrap; }
.mon-event-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.mon-inspector-title { font-weight: 700; font-size: var(--fs-4); line-height: var(--lh-tight); margin: var(--sp-1) 0 var(--sp-3); }
.mon-what { margin: 0 0 var(--sp-3); }
.mon-what-summary { white-space: pre-wrap; font-size: var(--fs-3); line-height: var(--lh-body); background: color-mix(in srgb, var(--brand) 6%, transparent); border-radius: var(--r-1); padding: var(--sp-2) var(--sp-3); }
.mon-what-source { font-size: var(--fs-1); margin-top: var(--sp-1); }
.mon-inspector h3.mon-kicker { margin: var(--sp-4) 0 var(--sp-2); }
.mon-meta-grid { display: grid; grid-template-columns: auto 1fr; gap: var(--sp-1) var(--sp-3); align-items: baseline; margin: 0 0 var(--sp-4); }
.mon-meta-grid dt { color: var(--muted); font-size: var(--fs-1); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
.mon-meta-grid dd { margin: 0; overflow-wrap: anywhere; }
.mon-toolcalls { display: flex; flex-direction: column; gap: var(--sp-1); margin: 0; }
.mon-toolcall { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); padding: var(--sp-1) var(--sp-2); border: 1px solid var(--border); border-radius: var(--r-1); background: var(--panel); }
.mon-output { margin: 0; padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-2); background: var(--panel); font-size: var(--fs-1); line-height: var(--lh-body); white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: auto; max-height: 45vh; overflow-y: auto; }
.mon-output-fields { display: flex; flex-direction: column; gap: var(--sp-3); white-space: normal; }
.mon-output-field { display: flex; flex-direction: column; gap: var(--sp-1); }
.mon-output-field:has(.mon-output-scalar) { flex-direction: row; align-items: baseline; gap: var(--sp-2); }
.mon-output-key { color: var(--dim); font-size: var(--fs-1); flex: none; }
.mon-output-scalar { min-width: 0; overflow-wrap: anywhere; }
.mon-output-val { margin: 0; padding: var(--sp-2); border: 1px solid var(--border); border-radius: var(--r-1); background: var(--bg); font-size: var(--fs-1); line-height: var(--lh-body); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 30vh; overflow-y: auto; }
.mon-failure { border-color: color-mix(in srgb, var(--err) 45%, var(--border)); }
.mon-live-output { max-height: 32vh; }
.mon-live-line { border-bottom: 1px dashed color-mix(in srgb, var(--border) 55%, transparent); overflow-wrap: anywhere; }
.mon-live-cmd { font-family: ui-monospace, monospace; color: color-mix(in srgb, var(--text) 82%, transparent); }
.mon-live-text { }
.mon-live-meta { color: var(--muted); font-style: italic; }
.mon-live-pending { display: inline-flex; align-items: center; gap: var(--sp-2); }
.mon-live-line:last-child { border-bottom: 0; }
.mon-quota { flex-direction: column; align-items: flex-start; }
.mon-health { flex-direction: column; align-items: flex-start; gap: var(--sp-1); }
.mon-health-headline { display: flex; align-items: center; gap: var(--sp-2); }
.mon-health-actions { display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--sp-2); }
.mon-health-dot { width: 8px; height: 8px; border-radius: var(--r-full); background: var(--tone); box-shadow: 0 0 6px color-mix(in srgb, var(--tone) 60%, transparent); }
.mon-health-detail { font-weight: 400; overflow-wrap: anywhere; }
.mon-health-fix { font-weight: 400; font-size: var(--fs-1); }
.mon-quota-list { margin: var(--sp-1) 0 0; padding-left: var(--sp-4); font-weight: 400; font-size: var(--fs-1); }
.mon-quota-list li { overflow-wrap: anywhere; }
.mon-modal-backdrop { position: fixed; inset: 0; z-index: 60; background: rgb(var(--shadow-rgb) / 0.55); display: flex; align-items: center; justify-content: center; padding: var(--sp-6); }
.mon-modal { width: min(1280px, 96vw); height: min(860px, 92vh); display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-3); overflow: hidden; box-shadow: 0 18px 60px rgb(var(--shadow-rgb) / 0.45); }
.mon-modal-head { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border); }
.mon-modal-head .mon-kicker { flex: 1; }
.mon-modal-frame { flex: 1; border: 0; width: 100%; background: var(--bg); }

/* PTY hijack terminal: the modal hosts one xterm.js instance; the mount fills
   the modal body and the terminal's own theme paints the surface. */
.mon-hijack-modal { width: min(1080px, 96vw); height: min(720px, 88vh); }
.mon-hijack-terminal { flex: 1; min-height: 0; padding: var(--sp-2) var(--sp-3); background: var(--code-bg); color: var(--code-text); border: 0 solid var(--brand); outline-color: color-mix(in srgb, var(--brand) 30%, transparent); }
.mon-hijack-terminal .xterm { height: 100%; }

.mon-empty { color: var(--muted); text-align: center; padding: var(--sp-6) var(--sp-3); display: flex; flex-direction: column; gap: var(--sp-1); }
.mon-empty-hero { padding-top: 18vh; }

/* Workspace overview: ops strip above the runs table, crons panel below.
   The runs table keeps the scrollable middle; the strip and crons are fixed. */
.mon-overview { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.mon-overview .mon-runs-table-panel { flex: 1; min-height: 200px; }
.mon-ops-strip { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin: 0 0 var(--sp-4); }
.mon-stat { flex: 1 1 120px; min-width: 0; max-width: 240px; border: 1px solid var(--border); border-radius: var(--r-2); background: var(--surface); padding: var(--sp-2) var(--sp-3); }
.mon-stat-value { font-size: var(--fs-4); font-weight: 700; font-variant-numeric: tabular-nums; line-height: var(--lh-tight); color: var(--tone, var(--text)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mon-stat-label { font-size: var(--fs-1); line-height: var(--lh-tight); color: var(--muted); margin-top: var(--sp-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mon-stat-sub { font-size: var(--fs-1); line-height: var(--lh-tight); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* Crons panel: fixed below the table; its own horizontal scroll if narrow. */
.mon-crons-panel { margin: var(--sp-4) 0 0; flex: none; }
.mon-crons-scroll { overflow: auto; max-height: 32vh; border: 1px solid var(--border); border-radius: var(--r-2); }
.mon-cron-error { max-width: 320px; overflow: hidden; text-overflow: ellipsis; font-size: var(--fs-1); }

/* Scores: run panel rows + inspector chips share the tone system. */
.mon-scores-panel .mon-panel-head { margin-bottom: var(--sp-2); }
.mon-scores-list { display: flex; flex-direction: column; }
.mon-score-row { display: flex; align-items: baseline; gap: var(--sp-2); padding: var(--sp-1) 0; border-bottom: 1px solid var(--border); font-size: var(--fs-2); }
.mon-score-row:last-child { border-bottom: 0; }
.mon-score-pill { flex: none; }
.mon-score-name { font-weight: 600; white-space: nowrap; }
.mon-score-node { flex: none; overflow: hidden; text-overflow: ellipsis; max-width: 220px; white-space: nowrap; }
.mon-score-reason { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.mon-scores-details > .mon-scores-summary { display: flex; align-items: center; gap: var(--sp-2); cursor: pointer; list-style: none; font-size: var(--fs-2); font-weight: 600; padding: var(--sp-1) 0; }
.mon-scores-summary::-webkit-details-marker { display: none; }
.mon-scores-details[open] > .mon-scores-summary .mon-diff-caret { transform: rotate(90deg); }
.mon-node-scores { display: flex; flex-wrap: wrap; gap: var(--sp-1); margin: 0 0 var(--sp-3); }
.mon-score-chip { color: var(--tone); border-color: color-mix(in srgb, var(--tone) 40%, var(--border)); }

/* Footprint: collapsed one-line rollup; open = per-directory sections with an
   added/removed ratio bar and per-file rows that focus the owning node. */
.mon-footprint-panel > summary { cursor: pointer; list-style: none; font-size: var(--fs-2); font-weight: 600; padding: var(--sp-1) 0; }
.mon-footprint-panel > summary::-webkit-details-marker { display: none; }
.mon-footprint-directory { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-1) 0; font-size: var(--fs-2); font-variant-numeric: tabular-nums; }
.mon-footprint-bar { display: inline-flex; width: 96px; height: 6px; border-radius: var(--r-full); overflow: hidden; background: var(--border); flex: none; }
.mon-footprint-added { background: var(--ok); }
.mon-footprint-removed { background: var(--err); }
.mon-footprint-file { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); padding: var(--sp-1) 0 var(--sp-1) var(--sp-4); border-bottom: 1px solid var(--border); font-size: var(--fs-1); font-variant-numeric: tabular-nums; color: var(--muted); }
.mon-footprint-file:last-child { border-bottom: 0; }

/* Metrics view: sections of label/value rows, monospace numbers. */
.mon-metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--sp-4) var(--sp-6); }
.mon-metrics-section .mon-kicker { margin: 0 0 var(--sp-2); }
.mon-metrics-table { display: flex; flex-direction: column; }
.mon-metric-row { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-3); padding: var(--sp-1) 0; border-bottom: 1px solid var(--border); font-size: var(--fs-2); }
.mon-metric-row:last-child { border-bottom: 0; }
.mon-metric-head { color: var(--muted); font-size: var(--fs-1); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
.mon-metric-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.mon-metric-label.tone-ok, .mon-metric-value.tone-ok { color: var(--ok); }
.mon-metric-label.tone-failed, .mon-metric-value.tone-failed { color: var(--err); }
.mon-metric-value { font-variant-numeric: tabular-nums; white-space: nowrap; flex: none; }

.mon-attention { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin: 0 0 var(--sp-3); padding: var(--sp-2); border: 1px solid var(--border); border-radius: var(--r-2); background: var(--surface); }
.mon-attention .mon-kicker { flex-basis: 100%; }
.mon-attention button { border: 0; border-radius: var(--r-1); padding: var(--sp-1) var(--sp-2); background: color-mix(in srgb, var(--tone) 12%, transparent); color: var(--tone, var(--text)); cursor: pointer; text-align: left; }
.mon-attention .tone-crit { --tone: var(--err); }
.mon-attention .tone-warn { --tone: var(--warn); }
.mon-badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 0 var(--sp-1); font-size: var(--fs-1); font-weight: 600; white-space: nowrap; }
.mon-badge.tone-failed { color: var(--err); background: color-mix(in srgb, var(--err) 14%, transparent); }

/* Overview has three deliberate layouts: a persistent rail on desktop, a
   narrower rail beside the table on tablet, and vertically stacked controls,
   rail, and table on phones. The table keeps its own horizontal scrollport
   at the smallest width so the shell itself never needs to overflow. */
@media (max-width: 760px) {
  .mon-shell { height: auto; min-height: 100vh; overflow: visible; }
  .mon-topbar { align-items: stretch; padding: var(--sp-3); }
  .mon-brand { flex-wrap: wrap; }
  .mon-toolbar { width: 100%; }
  .mon-filter-input { flex: 1 1 100%; min-width: 0; }
  .mon-toolbar [data-slot="select-trigger"] { flex: 1 1 140px; min-width: 0; }
  .mon-body { display: block; overflow: visible; }
  .mon-rail { max-height: 30vh; overflow-y: auto; border-right: 0; border-bottom: 1px solid var(--border); padding: var(--sp-3); }
  .mon-main { overflow: visible; padding: var(--sp-3); }
  .mon-overview { height: auto; }
  .mon-overview .mon-runs-table-panel { min-height: 320px; }
  .mon-runs-scroll { overflow: auto; }
  .mon-runs-pagination { align-items: flex-start; }
  .mon-runs-pagination-controls { flex-wrap: wrap; }
  .mon-crons-panel { max-width: 100%; }
}

@keyframes mon-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes mon-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) {
  .mon-dot-pulse, .mon-panel, .mon-banner, .mon-inspector, .mon-inbox { animation: none; }
  * { transition-duration: 0.001ms !important; animation-duration: 0.001ms !important; }
}
`;
