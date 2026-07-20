/**
 * The shadcn-style semantic token bridge onto the Smithers ui-styleguide theme.
 *
 * Every value is a `var(--house-token, #lightFallback)` expression:
 *
 * - When the workflow UI style guide is present (the gateway host page inlines
 *   `workflowUiThemeCss` into every `/workflows/<key>` page, and
 *   `SmithersUiStyles withTheme` covers standalone hosts), the values resolve
 *   through the house custom properties and follow the active theme: OS
 *   `prefers-color-scheme` plus an explicit `data-theme="dark|light"` stamp on
 *   `<html>` (settable via the host page's `?theme=` query param). The
 *   `data-theme` override always wins over the media query.
 * - Without the style guide, the fallbacks reproduce the exact light values,
 *   so components render sensibly standalone with no CSS loader.
 *
 * INVARIANTS (enforced by tests/css-contract.test.ts):
 *
 * - This package NEVER emits a `:root { ... }` token block. The styleguide
 *   already defines page-global `--primary`/`--accent`/`--muted` aliases with
 *   different semantics than shadcn's; redefining shadcn's canonical tokens at
 *   the root would silently recolor every legacy `.pill`/`.badge`/`.button` in
 *   the same document. The bridge lives only in these var() expressions.
 * - Never string-concatenate an alpha suffix onto a token. Use the shared
 *   semantic `*Soft`/`*Border` tokens where they apply; custom tints must use
 *   `color-mix(in srgb, ...)`, matching the house recipes byte-for-byte.
 */
export const tokens = {
  /** Page background. */
  background: "var(--bg, #fafafa)",
  /** Default text color. */
  foreground: "var(--text, #18181b)",
  /** Card / panel / popover surface. */
  card: "var(--surface, #ffffff)",
  cardForeground: "var(--text, #18181b)",
  /** Raised surface one step below card (insets, secondary fills). */
  surface2: "var(--surface-2, #f4f4f5)",
  /** Overlay surface (popovers, dialogs). */
  surface3: "var(--surface-3, #ffffff)",
  /** Frosted surfaces used by the floating Multi-style chat composer. */
  glass: "var(--surface-glass, rgba(255,255,255,0.72))",
  glassStrong: "var(--surface-glass-strong, rgba(255,255,255,0.85))",
  popover: "var(--surface-3, #ffffff)",
  popoverForeground: "var(--text, #18181b)",
  /** Brand color. The house "primary" button is TINTED (10% brand surface + brand text), not solid. */
  primary: "var(--brand, #6d56d8)",
  /** Tinted brand surface/border for soft emphasis (chips, active rows). */
  primarySoft: "var(--brand-soft, color-mix(in srgb, var(--brand, #6d56d8) 10%, var(--surface, #ffffff)))",
  primarySoftStrong: "var(--brand-soft-strong, color-mix(in srgb, var(--brand, #6d56d8) 16%, var(--surface, #ffffff)))",
  primaryBorder: "var(--brand-border, color-mix(in srgb, var(--brand, #6d56d8) 40%, transparent))",
  /**
   * Text on solid brand fills. --inverse-text is white in light mode and near
   * black in dark mode, which tracks the brand value getting lighter in dark.
   */
  primaryForeground: "var(--inverse-text, #fafafa)",
  /** Subtle raised surface (hover states, secondary buttons, muted fills). */
  secondary: "var(--hover, #f4f4f5)",
  secondaryForeground: "var(--text, #18181b)",
  muted: "var(--hover, #f4f4f5)",
  mutedForeground: "var(--text-muted, #52525b)",
  accent: "var(--hover, #f4f4f5)",
  accentForeground: "var(--text, #18181b)",
  destructive: "var(--danger, #c5343f)",
  destructiveSoft: "var(--danger-soft, color-mix(in srgb, var(--danger, #c5343f) 10%, var(--surface, #ffffff)))",
  destructiveBorder: "var(--danger-border, color-mix(in srgb, var(--danger, #c5343f) 40%, transparent))",
  success: "var(--success, #087461)",
  successSoft: "var(--success-soft, color-mix(in srgb, var(--success, #087461) 12%, var(--surface, #ffffff)))",
  successBorder: "var(--success-border, color-mix(in srgb, var(--success, #087461) 40%, transparent))",
  warning: "var(--warning, #955600)",
  warningSoft: "var(--warning-soft, color-mix(in srgb, var(--warning, #955600) 12%, var(--surface, #ffffff)))",
  warningBorder: "var(--warning-border, color-mix(in srgb, var(--warning, #955600) 40%, transparent))",
  info: "var(--info, #2f6fde)",
  infoSoft: "var(--info-soft, color-mix(in srgb, var(--info, #2f6fde) 10%, var(--surface, #ffffff)))",
  infoBorder: "var(--info-border, color-mix(in srgb, var(--info, #2f6fde) 40%, transparent))",
  /** Hairline borders. */
  border: "var(--border, rgba(24,24,27,0.08))",
  borderStrong: "var(--border-strong, rgba(24,24,27,0.14))",
  /** Form control borders (slightly stronger). */
  input: "var(--border-solid, #e4e4e7)",
  /** Focus ring fill; pair with a 50% brand border-color (the house focus rule). */
  ring: "color-mix(in srgb, var(--brand, #6d56d8) 22%, transparent)",
  ringBorder: "color-mix(in srgb, var(--brand, #6d56d8) 50%, transparent)",
  /** Extra-subtle fill for chips and hover washes. */
  hoverSubtle: "var(--hover-subtle, rgba(24,24,27,0.04))",
  /** Faint text (placeholders use --text-placeholder). */
  textFaint: "var(--text-faint, #71717a)",
  placeholder: "var(--text-placeholder, #9f9fa8)",
  /** Inverse surface/text (tooltips, "ink" chips). */
  inverseBg: "var(--inverse-bg, #18181b)",
  inverseText: "var(--inverse-text, #fafafa)",
  /** Code block colors. */
  codeBg: "var(--code-bg, #18181b)",
  codeText: "var(--code-text, #f4f4f5)",
  /** Shadow base as space-separated RGB channels, for `rgb(${tokens.shadowRgb} / a)`. */
  shadowRgb: "var(--shadow-rgb, 24 24 27)",
  /** Card corner radius. Controls use `radiusControl`. */
  radius: "var(--r-2, 10px)",
  radiusControl: "var(--r-1, 6px)",
  /** Shared control height (buttons, inputs, selects, triggers). */
  controlHeight: "var(--ctl-h, 32px)",
  fontSans:
    'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontMono:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace',
} as const;

export type SmithersUiTokens = typeof tokens;
