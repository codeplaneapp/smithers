export const SANDBOX_CSS_ID = "sandbox-previews";

export const sandboxCss = `
.sui-sandbox { border:1px solid var(--border, rgba(24,24,27,0.08)); border-radius:var(--r-2, 10px); background:var(--surface, #ffffff); overflow:hidden; }
.sui-sandbox-trigger { display:flex; align-items:center; gap:6px; width:100%; padding:8px 10px; border:0; background:transparent; color:var(--text, #18181b); font:inherit; font-size:var(--fs-2, 12px); font-weight:650; cursor:pointer; text-align:left; }
.sui-sandbox-trigger:hover { background:var(--hover-subtle, rgba(24,24,27,0.04)); }
.sui-sandbox-trigger:focus-visible { outline:none; border-color:color-mix(in srgb, var(--brand, #6d56d8) 50%, transparent); box-shadow:0 0 0 3px color-mix(in srgb, var(--brand, #6d56d8) 22%, transparent); }
.sui-sandbox-chevron { display:inline-block; transition:transform 120ms ease; color:var(--text-muted, #52525b); }
.sui-sandbox[data-state='open'] > .sui-sandbox-trigger .sui-sandbox-chevron { transform:rotate(90deg); }
.sui-sandbox-header { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:6px 10px; border-top:1px solid var(--border, rgba(24,24,27,0.08)); font-size:var(--fs-2, 12px); }
.sui-sandbox-identity { display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0; flex:1; }
.sui-sandbox-workspace, .sui-sandbox-repository { display:inline-flex; align-items:center; gap:4px; color:var(--text-muted, #52525b); font-family:ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace; }
.sui-sandbox-repository { color:var(--text, #18181b); }
.sui-sandbox-actions { display:flex; align-items:center; gap:6px; padding:6px 10px; border-top:1px solid var(--border, rgba(24,24,27,0.08)); }
.sui-sandbox-action { display:inline-flex; align-items:center; gap:4px; min-height:var(--ctl-h, 32px); padding:0 10px; border:1px solid var(--border-solid, #e4e4e7); border-radius:var(--r-1, 6px); background:var(--surface, #ffffff); color:var(--text, #18181b); font:inherit; font-size:var(--fs-2, 12px); cursor:pointer; }
.sui-sandbox-action:hover { background:var(--hover, #f4f4f5); }
.sui-sandbox-action:focus-visible { outline:none; border-color:color-mix(in srgb, var(--brand, #6d56d8) 50%, transparent); box-shadow:0 0 0 3px color-mix(in srgb, var(--brand, #6d56d8) 22%, transparent); }
.sui-sandbox-content { border-top:1px solid var(--border, rgba(24,24,27,0.08)); padding:8px 10px; }
.sui-webpreview { display:flex; flex-direction:column; border:1px solid var(--border, rgba(24,24,27,0.08)); border-radius:var(--r-2, 10px); background:var(--surface, #ffffff); overflow:hidden; }
.sui-webpreview-toolbar { display:flex; align-items:center; gap:4px; padding:6px 8px; border-bottom:1px solid var(--border, rgba(24,24,27,0.08)); }
.sui-webpreview-toolbar-button { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; border:0; border-radius:var(--r-1, 6px); background:transparent; color:var(--text-muted, #52525b); font:inherit; cursor:pointer; }
.sui-webpreview-toolbar-button:hover { background:var(--hover, #f4f4f5); color:var(--text, #18181b); }
.sui-webpreview-toolbar-button:focus-visible { outline:none; box-shadow:0 0 0 3px color-mix(in srgb, var(--brand, #6d56d8) 22%, transparent); }
.sui-webpreview-address { flex:1; min-width:0; }
.sui-webpreview-address-row { display:flex; flex-direction:column; gap:2px; flex:1; min-width:0; }
.sui-webpreview-address-error { color:var(--danger, #c5343f); font-size:var(--fs-2, 12px); }
.sui-webpreview-content { position:relative; min-height:120px; background:var(--surface-2, #f4f4f5); }
.sui-webpreview-frame { display:block; width:100%; height:100%; min-height:120px; border:0; background:var(--surface, #ffffff); }
.sui-webpreview-loading { position:absolute; inset:0; z-index:1; }
.sui-jsxpreview { border:1px solid var(--border, rgba(24,24,27,0.08)); border-radius:var(--r-2, 10px); background:var(--surface, #ffffff); overflow:hidden; }
.sui-jsxpreview-frame { padding:8px 10px; }
`;
