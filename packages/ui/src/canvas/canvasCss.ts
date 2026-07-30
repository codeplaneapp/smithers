/**
 * workflow-canvas lane CSS fragment. Renderer-neutral canvas anatomy styles,
 * all `sui-canvas-*` namespaced and colored only through the tokens bridge
 * (`var(--house-token, lightFallback)` / `color-mix(in srgb, ...)`). Composed
 * into `smithersUiCss` by the integration lane; until then (and harmlessly
 * after) every canvas component self-injects this via `useInjectLaneCss`.
 */
export const WORKFLOW_CANVAS_CSS_ID = "workflow-canvas";

export const canvasCss = `
.sui-canvas { position:relative; width:100%; height:100%; min-height:240px; overflow:hidden; background:var(--surface-2, #f4f4f5); border-radius:var(--r-2, 10px); }
.sui-canvas-node { display:grid; gap:6px; align-content:center; box-sizing:border-box; min-width:180px; padding:12px 14px; border:1px solid var(--border, rgba(24,24,27,0.08)); border-radius:var(--r-1, 6px); background:var(--surface, #ffffff); box-shadow:0 8px 18px rgb(var(--shadow-rgb, 24 24 27) / 0.08); }
.sui-canvas-node[data-selected='true'] { border-color:color-mix(in srgb, var(--brand, #6d56d8) 50%, transparent); box-shadow:0 0 0 3px color-mix(in srgb, var(--brand, #6d56d8) 22%, transparent), 0 8px 18px rgb(var(--shadow-rgb, 24 24 27) / 0.08); }
.sui-canvas-node-header { display:flex; align-items:center; gap:6px; min-width:0; }
.sui-canvas-node-kind { flex:none; text-transform:uppercase; }
.sui-canvas-node-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; font-weight:650; color:var(--text, #18181b); }
.sui-canvas-node-status { margin-left:auto; flex:none; }
.sui-canvas-node-content { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-muted, #52525b); font-size:var(--fs-2, 12px); }
.sui-canvas-edge { display:inline-flex; align-items:center; gap:6px; padding:2px 8px; border:1px solid var(--border, rgba(24,24,27,0.08)); border-radius:var(--r-full, 999px); background:var(--surface, #ffffff); color:var(--text-muted, #52525b); font-size:var(--fs-2, 12px); }
.sui-canvas-edge-glyph { display:inline-flex; align-items:center; justify-content:center; width:12px; height:12px; flex:none; font-size:10px; line-height:1; color:var(--text-muted, #52525b); }
.sui-canvas-edge[data-status-class='run'] .sui-canvas-edge-glyph { color:var(--brand, #6d56d8); }
.sui-canvas-edge[data-status-class='ok'] .sui-canvas-edge-glyph { color:var(--success, #087461); }
.sui-canvas-edge[data-status-class='warn'] .sui-canvas-edge-glyph { color:var(--warning, #916000); }
.sui-canvas-edge[data-status-class='bad'] .sui-canvas-edge-glyph { color:var(--danger, #c5343f); }
.sui-canvas-edge-arrow { color:var(--text-faint, #6d6d75); }
.sui-canvas-edge-label { color:var(--text, #18181b); }
.sui-canvas-connection { display:inline-block; width:48px; border-top:2px dashed var(--border-strong, rgba(24,24,27,0.14)); }
.sui-canvas-connection[data-status='valid'] { border-top-style:solid; border-top-color:var(--success, #087461); }
.sui-canvas-connection[data-status='invalid'] { border-top-color:var(--danger, #c5343f); }
.sui-canvas-connection[data-status='pending'] { border-top-color:var(--brand, #6d56d8); }
.sui-canvas-controls { display:flex; flex-direction:column; gap:2px; width:max-content; padding:4px; border:1px solid var(--border, rgba(24,24,27,0.08)); border-radius:var(--r-1, 6px); background:var(--surface, #ffffff); box-shadow:0 2px 8px rgb(var(--shadow-rgb, 24 24 27) / 0.08); }
.sui-canvas-controls-button { display:flex; align-items:center; justify-content:center; width:28px; height:28px; padding:0; border:0; border-radius:var(--r-1, 6px); background:transparent; color:var(--text, #18181b); font-size:18px; line-height:1; cursor:pointer; }
.sui-canvas-controls-button:hover { background:var(--hover, #f4f4f5); }
.sui-canvas-controls-button:focus-visible { outline:none; box-shadow:0 0 0 3px color-mix(in srgb, var(--brand, #6d56d8) 22%, transparent); }
.sui-canvas-panel { position:absolute; z-index:5; display:flex; gap:8px; margin:12px; max-width:calc(100% - 24px); }
.sui-canvas-panel[data-position='top-left'] { top:0; left:0; }
.sui-canvas-panel[data-position='top-right'] { top:0; right:0; }
.sui-canvas-panel[data-position='bottom-left'] { bottom:0; left:0; }
.sui-canvas-panel[data-position='bottom-right'] { bottom:0; right:0; }
.sui-canvas-toolbar { display:flex; align-items:center; gap:4px; width:max-content; padding:4px; border:1px solid var(--border, rgba(24,24,27,0.08)); border-radius:var(--r-1, 6px); background:var(--surface, #ffffff); }
.sui-canvas-minimap { box-sizing:border-box; width:160px; height:100px; overflow:hidden; border:1px solid var(--border, rgba(24,24,27,0.08)); border-radius:var(--r-1, 6px); background:var(--surface, #ffffff); box-shadow:0 2px 8px rgb(var(--shadow-rgb, 24 24 27) / 0.08); }
`;
