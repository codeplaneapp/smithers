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
 * - Never string-concatenate an alpha suffix onto a token. Derive tints with
 *   `color-mix(in srgb, ${token} N%, transparent)` -- `in srgb` specifically,
 *   matching the house recipes byte-for-byte (Tailwind-style oklab mixing
 *   drifts visibly on brand tints).
 */
export const tokens = {
  /** Page background. */
  background: "var(--bg, #ffffff)",
  /** Default text color. */
  foreground: "var(--text, #0a0a0a)",
  /** Card / panel / popover surface. */
  card: "var(--surface, #ffffff)",
  cardForeground: "var(--text, #0a0a0a)",
  /** Frosted surfaces used by the floating Multi-style chat composer. */
  glass: "var(--surface-glass, rgba(255,255,255,0.72))",
  glassStrong: "var(--surface-glass-strong, rgba(255,255,255,0.85))",
  popover: "var(--surface, #ffffff)",
  popoverForeground: "var(--text, #0a0a0a)",
  /** Brand color. The house "primary" button is TINTED (10% brand surface + brand text), not solid. */
  primary: "var(--brand, #6d56d8)",
  /**
   * Text on solid brand fills. --inverse-text is white in light mode and near
   * black in dark mode, which tracks the brand value getting lighter in dark.
   */
  primaryForeground: "var(--inverse-text, #ffffff)",
  /** Subtle raised surface (hover states, secondary buttons, muted fills). */
  secondary: "var(--hover, #f4f4f4)",
  secondaryForeground: "var(--text, #0a0a0a)",
  muted: "var(--hover, #f4f4f4)",
  mutedForeground: "var(--text-muted, #525252)",
  accent: "var(--hover, #f4f4f4)",
  accentForeground: "var(--text, #0a0a0a)",
  destructive: "var(--danger, #e5484d)",
  success: "var(--success, #0f8f78)",
  warning: "var(--warning, #bf7100)",
  /** Hairline borders. */
  border: "var(--border, rgba(10,10,10,0.08))",
  borderStrong: "var(--border-strong, rgba(10,10,10,0.14))",
  /** Form control borders (slightly stronger). */
  input: "var(--border-solid, #ededed)",
  /** Focus ring fill; pair with a 50% brand border-color (the house focus rule). */
  ring: "color-mix(in srgb, var(--brand, #6d56d8) 22%, transparent)",
  ringBorder: "color-mix(in srgb, var(--brand, #6d56d8) 50%, transparent)",
  /** Extra-subtle fill for chips and hover washes. */
  hoverSubtle: "var(--hover-subtle, rgba(10,10,10,0.03))",
  /** Faint text (placeholders use --text-placeholder). */
  textFaint: "var(--text-faint, #6f6f6f)",
  placeholder: "var(--text-placeholder, #767676)",
  /** Inverse surface/text (tooltips, "ink" chips). */
  inverseBg: "var(--inverse-bg, #0a0a0a)",
  inverseText: "var(--inverse-text, #ffffff)",
  /** Code block colors. */
  codeBg: "var(--code-bg, #0a0a0a)",
  codeText: "var(--code-text, #f4f4f4)",
  /** Shadow base as space-separated RGB channels, for `rgb(${tokens.shadowRgb} / a)`. */
  shadowRgb: "var(--shadow-rgb, 10 10 10)",
  /** Card corner radius (px). Controls use `radiusControl`. */
  radius: "8px",
  radiusControl: "6px",
  fontSans:
    'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontMono:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace',
} as const;

export type SmithersUiTokens = typeof tokens;
