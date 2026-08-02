export const lightTokens = [
  "color-scheme:light",
  "font-family:var(--font-sans)",
  // Font stacks. Sans carries the UI; mono is reserved for code, ids, and
  // tabular data. Never set body copy in mono.
  "--font-sans:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
  "--font-mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace",
  // Neutrals (zinc ramp). bg is one step below surface so cards read as
  // raised without heavy shadows.
  "--bg:#fafafa",
  "--text:#18181b",
  "--text-muted:#52525b",
  "--text-faint:#6d6d75",
  "--text-placeholder:#8a8a93",
  // Elevation ramp: bg < surface (cards) < surface-2 (inset/hover) <
  // surface-3 (overlays, popovers).
  "--surface:#ffffff",
  "--surface-2:#f4f4f5",
  "--surface-3:#ffffff",
  "--surface-glass:rgba(255,255,255,0.72)",
  "--surface-glass-strong:rgba(255,255,255,0.85)",
  "--border:rgba(24,24,27,0.08)",
  "--border-strong:rgba(24,24,27,0.14)",
  "--border-solid:#e4e4e7",
  "--hover:#f4f4f5",
  "--hover-subtle:rgba(24,24,27,0.04)",
  "--inverse-bg:#18181b",
  "--inverse-text:#fafafa",
  "--code-bg:#18181b",
  "--code-text:#f4f4f5",
  "--inline-code-bg:rgba(24,24,27,0.06)",
  // Semantic colors. brand = action/active, info = neutral-highlight,
  // success = done, warning = needs-attention/waiting, danger = failed.
  // Light values are darkened so 11px badge text stays >= 4.5:1 on the
  // matching *-soft tint, not just on white.
  "--brand:#6d56d8",
  "--success:#087461",
  "--danger:#c5343f",
  "--warning:#916000",
  "--info:#2a63c9",
  "--shadow-rgb:24 24 27",
  // Elevation shadows, weakest to strongest (card, raised, overlay).
  "--shadow-1:0 1px 2px rgb(var(--shadow-rgb) / 0.05)",
  "--shadow-2:0 1px 2px rgb(var(--shadow-rgb) / 0.04), 0 8px 24px rgb(var(--shadow-rgb) / 0.07)",
  "--shadow-3:0 4px 12px rgb(var(--shadow-rgb) / 0.10), 0 16px 48px rgb(var(--shadow-rgb) / 0.14)",
].join("; ");

export const darkTokens = [
  "color-scheme:dark",
  "--bg:#09090b",
  "--text:#f4f4f5",
  "--text-muted:#a1a1aa",
  "--text-faint:#8c8c95",
  "--text-placeholder:#75757e",
  "--surface:#141417",
  "--surface-2:#1b1b20",
  "--surface-3:#232329",
  "--surface-glass:rgba(20,20,23,0.72)",
  "--surface-glass-strong:rgba(20,20,23,0.85)",
  "--border:rgba(255,255,255,0.09)",
  "--border-strong:rgba(255,255,255,0.16)",
  "--border-solid:#2a2a30",
  "--hover:#1f1f24",
  "--hover-subtle:rgba(255,255,255,0.05)",
  "--inverse-bg:#f4f4f5",
  "--inverse-text:#18181b",
  "--code-bg:#0c0c0e",
  "--code-text:#e4e4e7",
  "--inline-code-bg:rgba(255,255,255,0.08)",
  "--brand:#8b78e6",
  "--success:#2ec9a8",
  "--danger:#f2555a",
  "--warning:#e0a23a",
  "--info:#6aa5f8",
  "--shadow-rgb:0 0 0",
  "--shadow-1:0 1px 2px rgb(var(--shadow-rgb) / 0.35)",
  "--shadow-2:0 1px 2px rgb(var(--shadow-rgb) / 0.30), 0 8px 24px rgb(var(--shadow-rgb) / 0.40)",
  "--shadow-3:0 4px 12px rgb(var(--shadow-rgb) / 0.45), 0 16px 48px rgb(var(--shadow-rgb) / 0.50)",
].join("; ");

// Theme-invariant tokens: aliases, soft tints (self-adapting color-mix over
// the semantic colors, correct in both themes), geometry, and type scale.
export const sharedTokens = [
  // Legacy aliases (do not remove; workflow UIs rely on them). Trap: this
  // page-vocabulary `--accent` is the BRAND violet, while the shadcn bridge's
  // `tokens.accent` (@smthrs/ui) is the hover fill -- never
  // treat the two as interchangeable.
  "--panel:var(--surface)",
  "--card:var(--surface)",
  "--line:var(--border-solid)",
  "--muted:var(--text-muted)",
  "--primary:var(--brand)",
  "--accent:var(--brand)",
  "--ok:var(--success)",
  "--warn:var(--warning)",
  "--warning-color:var(--warning)",
  "--bad:var(--danger)",
  "--err:var(--danger)",
  "--error:var(--danger)",
  "--blue:var(--info)",
  "--run:var(--brand)",
  "--crit:var(--danger)",
  "--major:var(--warning)",
  // Severity ladder stays distinct: crit=danger, major=warning, minor=info,
  // nit=muted (minor previously collapsed into warning).
  "--minor:var(--info)",
  "--nit:var(--muted)",
  "--me:var(--brand-soft)",
  "--ink:var(--inverse-bg)",
  // Soft tints + tint borders for the semantic colors. Use these instead of
  // hand-rolling color-mix percentages so every tinted surface matches.
  "--brand-soft:color-mix(in srgb, var(--brand) 10%, var(--surface))",
  "--brand-soft-strong:color-mix(in srgb, var(--brand) 16%, var(--surface))",
  "--brand-border:color-mix(in srgb, var(--brand) 40%, transparent)",
  "--success-soft:color-mix(in srgb, var(--success) 12%, var(--surface))",
  "--success-border:color-mix(in srgb, var(--success) 40%, transparent)",
  "--danger-soft:color-mix(in srgb, var(--danger) 10%, var(--surface))",
  "--danger-border:color-mix(in srgb, var(--danger) 40%, transparent)",
  "--warning-soft:color-mix(in srgb, var(--warning) 12%, var(--surface))",
  "--warning-border:color-mix(in srgb, var(--warning) 40%, transparent)",
  "--info-soft:color-mix(in srgb, var(--info) 10%, var(--surface))",
  "--info-border:color-mix(in srgb, var(--info) 40%, transparent)",
  "--ring:color-mix(in srgb, var(--brand) 22%, transparent)",
  "--ring-border:color-mix(in srgb, var(--brand) 50%, transparent)",
  // Geometry: spacing, type scale, radii, and shared control heights.
  // Spacing policy (enforced by @smthrs/ui css-contract tests):
  // the --sp scale (4px steps) paces layout-level spacing; component-internal
  // padding/gap sits on a 2px fine grid (even px values only, no 5/7/9px).
  // Weight roles: 650 is the only emphasis weight for titles/labels; 700 is
  // reserved for KPI numerals; body text is 400.
  "--sp-1:4px",
  "--sp-2:8px",
  "--sp-3:12px",
  "--sp-4:16px",
  "--sp-5:20px",
  "--sp-6:24px",
  "--sp-7:28px",
  "--sp-8:32px",
  "--fs-1:11px",
  "--fs-2:12px",
  "--fs-3:13px",
  "--fs-4:15px",
  "--fs-5:17px",
  "--fs-6:20px",
  "--fs-7:24px",
  "--lh-tight:1.35",
  "--lh-body:1.5",
  "--r-1:6px",
  "--r-2:10px",
  "--r-3:12px",
  "--r-4:16px",
  // Soft radius for chat bubbles and the floating glass composer.
  "--r-bubble:18px",
  "--r-full:999px",
  "--ctl-h:32px",
  "--ctl-h-sm:28px",
  "--ctl-h-lg:38px",
].join("; ");
