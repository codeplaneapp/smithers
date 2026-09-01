/**
 * The one audited tint percentage for a semantic fill that carries text in its
 * own semantic color.
 *
 * 10% is the ceiling, not a taste call: the darkest shipped seeds sit near
 * 4.6:1 on a plain `--surface`, so 11px badge text on an 11% tint already
 * misses WCAG AA in at least one palette. `tests/themeRegistry.test.ts` reads
 * this constant, so the recipes and their proof cannot drift apart.
 */
export const SOFT_TINT_AMOUNT = 0.1;

/**
 * The tint percentage for a fill that carries NO text in the tinted color.
 * Stronger than {@link SOFT_TINT_AMOUNT} and therefore only legal under
 * neutral (`--text`) or inverse foregrounds.
 */
export const STRONG_TINT_AMOUNT = 0.16;


const softTint = (semantic: string) =>
  `--${semantic}-soft:color-mix(in srgb, var(--${semantic}) ${SOFT_TINT_AMOUNT * 100}%, var(--surface))`;

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
  softTint("brand"),
  // NOT a text background. Brand text on a 16% brand tint measures below 4.5:1
  // in 10 of the 16 shipped variants, so the interactive states below express
  // hover and press through the border and elevation instead. Kept because the
  // shadcn bridge in `@smthrs/ui` names it for non-text fills.
  `--brand-soft-strong:color-mix(in srgb, var(--brand) ${STRONG_TINT_AMOUNT * 100}%, var(--surface))`,
  "--brand-border:color-mix(in srgb, var(--brand) 40%, transparent)",
  "--brand-border-strong:color-mix(in srgb, var(--brand) 65%, transparent)",
  softTint("success"),
  "--success-border:color-mix(in srgb, var(--success) 40%, transparent)",
  softTint("danger"),
  "--danger-border:color-mix(in srgb, var(--danger) 40%, transparent)",
  "--danger-border-strong:color-mix(in srgb, var(--danger) 65%, transparent)",
  softTint("warning"),
  "--warning-border:color-mix(in srgb, var(--warning) 40%, transparent)",
  softTint("info"),
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
