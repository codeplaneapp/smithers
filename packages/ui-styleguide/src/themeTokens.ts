import { serializeThemeVariant } from "./serializeThemeVariant.ts";
import { DEFAULT_THEME_KEY, themeRegistry } from "./themeRegistry.ts";

export const lightTokens = serializeThemeVariant(themeRegistry[DEFAULT_THEME_KEY].light);

export const darkTokens = serializeThemeVariant(themeRegistry[DEFAULT_THEME_KEY].dark);

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
