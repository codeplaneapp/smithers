import type { ReactNode } from "react";

export const workflowUiThemeCss = [
  ":root { color-scheme:light; font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
    " --bg:#ffffff; --text:#0a0a0a; --text-muted:#525252; --text-faint:#6f6f6f; --text-placeholder:#767676;" +
    " --surface:#ffffff; --surface-glass:rgba(255,255,255,0.72); --surface-glass-strong:rgba(255,255,255,0.85);" +
    " --border:rgba(10,10,10,0.08); --border-strong:rgba(10,10,10,0.14); --border-solid:#ededed;" +
    " --hover:#f4f4f4; --hover-subtle:rgba(10,10,10,0.03); --inverse-bg:#0a0a0a; --inverse-text:#ffffff;" +
    " --code-bg:#0a0a0a; --code-text:#f4f4f4; --inline-code-bg:rgba(10,10,10,0.07);" +
    " --brand:#6d56d8; --success:#0f8f78; --danger:#e5484d; --warning:#bf7100; --shadow-rgb:10 10 10;" +
    " --panel:var(--surface); --card:var(--surface); --line:var(--border-solid); --muted:var(--text-muted);" +
    " --primary:var(--brand); --accent:var(--brand); --ok:var(--success); --warn:var(--warning); --warning-color:var(--warning); --bad:var(--danger); --err:var(--danger); --error:var(--danger);" +
    " --blue:var(--brand); --run:var(--brand); --crit:var(--danger); --major:var(--warning); --minor:var(--warning); --nit:var(--muted); --me:color-mix(in srgb,var(--brand) 12%,var(--surface)); --ink:var(--inverse-bg); }",
  "@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { color-scheme:dark;" +
    " --bg:#0b0b0d; --text:#f4f4f5; --text-muted:#a1a1aa; --text-faint:#b0b0b8; --text-placeholder:#83838d;" +
    " --surface:#18181b; --surface-glass:rgba(24,24,27,0.72); --surface-glass-strong:rgba(24,24,27,0.85);" +
    " --border:rgba(255,255,255,0.1); --border-strong:rgba(255,255,255,0.18); --border-solid:#2a2a2e;" +
    " --hover:#26262b; --hover-subtle:rgba(255,255,255,0.05); --inverse-bg:#f4f4f5; --inverse-text:#0a0a0a;" +
    " --code-bg:#09090b; --code-text:#e4e4e7; --inline-code-bg:rgba(255,255,255,0.1);" +
    " --brand:#8b78e6; --success:#2ec9a8; --danger:#f2555a; --warning:#e0a23a; --shadow-rgb:0 0 0; } }",
  ":root[data-theme='dark'] { color-scheme:dark;" +
    " --bg:#0b0b0d; --text:#f4f4f5; --text-muted:#a1a1aa; --text-faint:#b0b0b8; --text-placeholder:#83838d;" +
    " --surface:#18181b; --surface-glass:rgba(24,24,27,0.72); --surface-glass-strong:rgba(24,24,27,0.85);" +
    " --border:rgba(255,255,255,0.1); --border-strong:rgba(255,255,255,0.18); --border-solid:#2a2a2e;" +
    " --hover:#26262b; --hover-subtle:rgba(255,255,255,0.05); --inverse-bg:#f4f4f5; --inverse-text:#0a0a0a;" +
    " --code-bg:#09090b; --code-text:#e4e4e7; --inline-code-bg:rgba(255,255,255,0.1);" +
    " --brand:#8b78e6; --success:#2ec9a8; --danger:#f2555a; --warning:#e0a23a; --shadow-rgb:0 0 0; }",
  "* { box-sizing:border-box; }",
  "body { min-width:320px; min-height:100vh; margin:0; background:var(--bg); color:var(--text); font-size:13px; font-synthesis:none; text-rendering:optimizeLegibility; -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale; }",
  "button,input,textarea,select { font:inherit; }",
  "button { color:inherit; }",
  "h1,h2,h3,p { margin:0; }",
  "h1 { color:var(--text); font-size:15px; font-weight:650; letter-spacing:0; }",
  "h2 { color:var(--text); font-size:14px; font-weight:700; letter-spacing:0; }",
  "h3 { color:var(--text); font-size:12.5px; font-weight:700; letter-spacing:0; }",
  "p { color:var(--muted); line-height:1.45; }",
  "code,.mono { font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; }",
  ".muted,.meta { color:var(--muted); }",
  ".top,.topbar { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 18px; border-bottom:1px solid var(--border); background:var(--surface-glass-strong); -webkit-backdrop-filter:blur(18px) saturate(180%); backdrop-filter:blur(18px) saturate(180%); }",
  ".title,.title-group { min-width:0; display:flex; align-items:center; gap:10px; }",
  ".toolbar,.actions { display:flex; align-items:center; justify-content:flex-end; gap:8px; min-width:0; flex-wrap:wrap; }",
  ".button,.primary,.secondary { min-height:32px; display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:0 12px; border:1px solid var(--line); border-radius:6px; background:var(--panel); color:var(--text); text-decoration:none; cursor:pointer; white-space:nowrap; }",
  ".button:hover,.primary:hover,.secondary:hover { background:var(--hover); }",
  ".button:focus-visible,.primary:focus-visible,.secondary:focus-visible,.icon-button:focus-visible,.tab:focus-visible,.run-row:focus-visible,.doc-link:focus-visible,.segmented:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible { outline:none; border-color:color-mix(in srgb,var(--brand) 50%,transparent); box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 22%,transparent); }",
  ".button:disabled,.primary:disabled,.secondary:disabled { cursor:not-allowed; opacity:.45; }",
  ".button.primary,.primary { border-color:color-mix(in srgb,var(--brand) 40%,transparent); background:color-mix(in srgb,var(--brand) 10%,var(--surface)); color:var(--brand); font-weight:650; }",
  ".button.primary:hover,.primary:hover { background:color-mix(in srgb,var(--brand) 16%,var(--surface)); }",
  ".button.danger,.danger { border-color:color-mix(in srgb,var(--danger) 38%,transparent); color:var(--danger); }",
  ".button.danger:hover,.danger:hover { background:color-mix(in srgb,var(--danger) 8%,var(--surface)); }",
  ".input,.textarea,.prompt,textarea.prompt,input[type='text'],input[type='search'],input[type='number'],select { min-width:0; border:1px solid var(--line); border-radius:6px; background:var(--panel); color:var(--text); outline:none; }",
  ".input,.prompt,input[type='text'],input[type='search'],input[type='number'],select { min-height:32px; padding:0 10px; }",
  ".textarea,textarea.prompt,textarea.input,textarea { padding:10px 12px; min-height:88px; resize:vertical; line-height:1.45; }",
  ".input::placeholder,.textarea::placeholder,.prompt::placeholder,textarea::placeholder,input::placeholder { color:var(--text-placeholder); }",
  ".pill,.badge,.chip { display:inline-flex; align-items:center; gap:6px; min-width:0; max-width:100%; min-height:22px; padding:1px 10px; border:1px solid var(--border); border-radius:999px; color:var(--text-muted); font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }",
  ".pill { border-color:color-mix(in srgb,var(--brand) 22%,transparent); background:color-mix(in srgb,var(--brand) 14%,transparent); color:var(--brand); }",
  ".pill.muted,.badge.muted,.chip { border-color:var(--border); background:var(--hover-subtle); color:var(--text-muted); }",
  ".badge { font-family:inherit; font-weight:650; text-transform:uppercase; }",
  ".badge.ok,.badge.finished,.badge.success { color:var(--success); border-color:color-mix(in srgb,var(--success),transparent 45%); }",
  ".badge.warn,.badge.running,.badge.pending,.badge.waiting,.badge.run { color:var(--warning); border-color:color-mix(in srgb,var(--warning),transparent 45%); }",
  ".badge.bad,.badge.failed { color:var(--danger); border-color:color-mix(in srgb,var(--danger),transparent 45%); }",
  ".badge.cancelled,.badge.canceled,.badge.skipped { color:var(--muted); border-color:var(--border); }",
  ".card,.panel,.kpi,.stat,.slot { min-width:0; border:1px solid var(--border); border-radius:8px; background:var(--surface); box-shadow:0 1px 2px rgb(var(--shadow-rgb) / 0.04), 0 8px 24px rgb(var(--shadow-rgb) / 0.06); }",
  ".card,.panel,.slot { padding:14px; }",
  ".card-head,.panel-title,.section-head { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:10px; }",
  ".section-head,.label,.field label,.field span { color:var(--muted); font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }",
  ".field { min-width:0; display:grid; gap:5px; }",
  ".empty { padding:24px; color:var(--muted); text-align:center; }",
  ".alert { border:1px solid var(--border); border-radius:8px; padding:12px; background:var(--surface); color:var(--muted); }",
  ".alert.err,.error-text { color:var(--danger); border-color:color-mix(in srgb,var(--danger) 45%,transparent); }",
  ".run-row { border-color:var(--border); color:var(--text); transition:border-color .12s ease, background .12s ease; }",
  ".run-row:hover,.run-row.active,.run-row.is-active { background:var(--hover); }",
  ".run-row.active,.run-row.is-active { border-color:color-mix(in srgb,var(--brand) 40%,transparent); box-shadow:inset 2px 0 0 var(--brand); }",
  ".table { width:100%; border-collapse:collapse; }",
  ".table th,.table td { padding:8px 9px; border-bottom:1px solid var(--border); text-align:left; vertical-align:top; }",
  ".table th { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; font-weight:700; }",
  ".code,.source,pre.code { display:block; min-width:0; overflow:auto; white-space:pre-wrap; font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; font-size:11px; line-height:1.55; color:var(--code-text); background:var(--code-bg); border:1px solid var(--border); border-radius:8px; padding:10px; }",
  ".plus { color:var(--success); } .minus { color:var(--danger); }",
  ".livelog { overflow:auto; background:var(--code-bg); border:1px solid var(--border); border-radius:8px; padding:8px; font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; font-size:11px; line-height:1.55; }",
  ".livelog-line { display:flex; gap:8px; padding:1px 0; white-space:pre-wrap; word-break:break-word; }",
  ".livelog-event { color:var(--brand); flex:none; }",
  ".livelog-node { color:var(--warning); flex:none; }",
  ".livelog-detail { color:var(--code-text); min-width:0; }",
  "* { scrollbar-width:thin; scrollbar-color:color-mix(in srgb,var(--text-muted) 35%,transparent) transparent; }",
  "@media (max-width: 760px) { .top,.topbar { align-items:flex-start; flex-direction:column; padding:10px 12px; } .toolbar,.actions { width:100%; justify-content:flex-start; } .button,.primary,.secondary { min-width:0; } }",
].join("\n");

export const workflowUiLayoutCss = [
  ".workflow-shell { height:100vh; width:100%; max-width:100vw; overflow:hidden; display:grid; grid-template-rows:auto 1fr; background:var(--bg); color:var(--text); }",
  ".workflow-content { min-width:0; min-height:0; overflow:auto; padding:16px 18px; display:grid; align-content:start; gap:14px; }",
  ".workflow-launch { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; align-items:start; }",
  ".workflow-dashboard { min-width:0; min-height:0; display:grid; grid-template-columns:minmax(240px,320px) minmax(0,1fr); gap:14px; align-items:start; }",
  ".workflow-runs { display:grid; align-content:start; gap:8px; }",
  ".workflow-run-row { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:12px; width:100%; padding:10px 12px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--text); text-align:left; cursor:pointer; box-shadow:0 1px 2px rgb(var(--shadow-rgb) / 0.04); }",
  ".workflow-run-row:hover,.workflow-run-row.active { background:var(--hover); border-color:color-mix(in srgb,var(--brand) 40%,transparent); }",
  ".workflow-run-row.active { box-shadow:inset 2px 0 0 var(--brand), 0 1px 2px rgb(var(--shadow-rgb) / 0.04); }",
  ".workflow-run-main { min-width:0; display:grid; gap:3px; }",
  ".workflow-run-id { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; font-size:12px; }",
  ".workflow-run-meta { color:var(--muted); font-size:11px; }",
  ".workflow-detail { min-width:0; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }",
  ".workflow-detail .panel { display:grid; gap:10px; }",
  ".workflow-tree,.workflow-events { min-height:220px; max-height:52vh; }",
  "@media (max-width: 980px) { .workflow-dashboard,.workflow-detail { grid-template-columns:1fr; } .workflow-tree,.workflow-events { max-height:360px; } }",
  "@media (max-width: 620px) { .workflow-content { padding:12px; } .workflow-launch { grid-template-columns:1fr; } .workflow-launch .button { width:100%; } }",
].join("\n");

export const workflowUiStyles = [workflowUiThemeCss, workflowUiLayoutCss].join("\n");

export type WorkflowUiStylesProps = {
  mode?: "theme" | "full";
  extra?: string;
  extraPlacement?: "before" | "after";
};

export function composeWorkflowUiStyles({
  mode = "full",
  extra,
  extraPlacement = "after",
}: WorkflowUiStylesProps = {}): string {
  const base = mode === "theme" ? workflowUiThemeCss : workflowUiStyles;
  if (!extra) return base;
  return extraPlacement === "before" ? [extra, base].join("\n") : [base, extra].join("\n");
}

export function WorkflowUiStyles(props: WorkflowUiStylesProps) {
  return <style>{composeWorkflowUiStyles(props)}</style>;
}

export type WorkflowUiShellProps = {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
};

export function WorkflowUiShell({ title, meta, actions, children, testId }: WorkflowUiShellProps) {
  return (
    <main className="workflow-shell" data-testid={testId}>
      <WorkflowUiStyles />
      <header className="topbar">
        <div className="title-group">
          <h1>{title}</h1>
          {meta}
        </div>
        {actions ? <div className="toolbar">{actions}</div> : null}
      </header>
      <div className="workflow-content">{children}</div>
    </main>
  );
}
