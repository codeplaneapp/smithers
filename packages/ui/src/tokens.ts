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
  background: "var(--bg, #FBFBFB)",
  /** Default text color. */
  foreground: "var(--text, #403f53)",
  /** Card / panel / popover surface. */
  card: "var(--surface, #f6f6f7)",
  cardForeground: "var(--text, #403f53)",
  /** Raised surface one step below card (insets, secondary fills). */
  surface2: "var(--surface-2, #f1f1f2)",
  /** Overlay surface (popovers, dialogs). */
  surface3: "var(--surface-3, #f9f9f9)",
  /** Frosted surfaces used by the floating Multi-style chat composer. */
  glass: "var(--surface-glass, rgba(246,246,247,0.72))",
  glassStrong: "var(--surface-glass-strong, rgba(246,246,247,0.85))",
  popover: "var(--surface-3, #f9f9f9)",
  popoverForeground: "var(--text, #403f53)",
  /** Brand color. The house "primary" button is TINTED (10% brand surface + brand text), not solid. */
  primary: "var(--brand, #8f46b5)",
  /** Tinted brand surface/border for soft emphasis (chips, active rows). */
  primarySoft: "var(--brand-soft, color-mix(in srgb, var(--brand, #8f46b5) 10%, var(--surface, #f6f6f7)))",
  primarySoftStrong: "var(--brand-soft-strong, color-mix(in srgb, var(--brand, #8f46b5) 16%, var(--surface, #f6f6f7)))",
  primaryBorder: "var(--brand-border, color-mix(in srgb, var(--brand, #8f46b5) 40%, transparent))",
  /**
   * Text on solid brand fills. --inverse-text is white in light mode and near
   * black in dark mode, which tracks the brand value getting lighter in dark.
   */
  primaryForeground: "var(--inverse-text, #FBFBFB)",
  /** Subtle raised surface (hover states, secondary buttons, muted fills). */
  secondary: "var(--hover, #f1f1f2)",
  secondaryForeground: "var(--text, #403f53)",
  muted: "var(--hover, #f1f1f2)",
  mutedForeground: "var(--text-muted, #7c7b89)",
  /**
   * shadcn's "accent" = the hover fill. Trap: the styleguide's page-global
   * `--accent` alias is the BRAND violet -- same word, different color. This
   * bridge deliberately does NOT read `--accent`.
   */
  accent: "var(--hover, #f1f1f2)",
  accentForeground: "var(--text, #403f53)",
  destructive: "var(--danger, #b33d3a)",
  destructiveSoft: "var(--danger-soft, color-mix(in srgb, var(--danger, #b33d3a) 10%, var(--surface, #f6f6f7)))",
  destructiveBorder: "var(--danger-border, color-mix(in srgb, var(--danger, #b33d3a) 40%, transparent))",
  success: "var(--success, #1f6e67)",
  successSoft: "var(--success-soft, color-mix(in srgb, var(--success, #1f6e67) 12%, var(--surface, #f6f6f7)))",
  successBorder: "var(--success-border, color-mix(in srgb, var(--success, #1f6e67) 40%, transparent))",
  warning: "var(--warning, #7b6001)",
  warningSoft: "var(--warning-soft, color-mix(in srgb, var(--warning, #7b6001) 12%, var(--surface, #f6f6f7)))",
  warningBorder: "var(--warning-border, color-mix(in srgb, var(--warning, #7b6001) 40%, transparent))",
  info: "var(--info, #3d62b3)",
  infoSoft: "var(--info-soft, color-mix(in srgb, var(--info, #3d62b3) 10%, var(--surface, #f6f6f7)))",
  infoBorder: "var(--info-border, color-mix(in srgb, var(--info, #3d62b3) 40%, transparent))",
  /** Hairline borders. */
  border: "var(--border, rgba(64,63,83,0.08))",
  borderStrong: "var(--border-strong, rgba(64,63,83,0.14))",
  /** Form control borders (slightly stronger). */
  input: "var(--border-solid, #e6e6e9)",
  /**
   * Focus ring fill; pair with a 50% brand border-color (the house focus
   * rule). Routed through the styleguide's `--ring`/`--ring-border` custom
   * properties so a host that themes the ring re-themes these components too.
   */
  ring: "var(--ring, color-mix(in srgb, var(--brand, #8f46b5) 22%, transparent))",
  ringBorder: "var(--ring-border, color-mix(in srgb, var(--brand, #8f46b5) 50%, transparent))",
  /** Extra-subtle fill for chips and hover washes. */
  hoverSubtle: "var(--hover-subtle, rgba(64,63,83,0.04))",
  /** Faint text (placeholders use --text-placeholder). */
  textFaint: "var(--text-faint, #92929d)",
  placeholder: "var(--text-placeholder, #a5a5ae)",
  /** Inverse surface/text (tooltips, "ink" chips). */
  inverseBg: "var(--inverse-bg, #403f53)",
  inverseText: "var(--inverse-text, #FBFBFB)",
  /** Code block colors. */
  codeBg: "var(--code-bg, #FBFBFB)",
  codeText: "var(--code-text, #403f53)",
  /** Shadow base as space-separated RGB channels, for `rgb(${tokens.shadowRgb} / a)`. */
  shadowRgb: "var(--shadow-rgb, 64 63 83)",
  /**
   * Elevation shadows, routed through the styleguide's `--shadow-*` custom
   * properties so dark mode gets the stronger house alphas (a fixed light
   * alpha is nearly invisible on dark surfaces) and hosts can theme them.
   */
  shadow1: "var(--shadow-1, 0 1px 2px rgb(64 63 83 / 0.05))",
  shadow2: "var(--shadow-2, 0 1px 2px rgb(64 63 83 / 0.04), 0 8px 24px rgb(64 63 83 / 0.07))",
  shadow3: "var(--shadow-3, 0 4px 12px rgb(64 63 83 / 0.10), 0 16px 48px rgb(64 63 83 / 0.14))",
  /** Card corner radius. Controls use `radiusControl`; chat surfaces use `radiusBubble`. */
  radius: "var(--r-2, 10px)",
  radiusControl: "var(--r-1, 6px)",
  radiusBubble: "var(--r-bubble, 18px)",
  radiusFull: "var(--r-full, 999px)",
  /** Shared control height (buttons, inputs, selects, triggers). */
  controlHeight: "var(--ctl-h, 32px)",
  /** Compact UI copy: the documented 12px type-scale step. */
  fontSizeCompact: "var(--fs-2, 12px)",
  /**
   * Font stacks routed through the styleguide's `--font-sans`/`--font-mono`
   * so hosts can theme typography; fallbacks are the canonical house stacks
   * (identical in ui-styleguide and gateway-ui -- keep all three in sync).
   */
  fontSans:
    "var(--font-sans, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif)",
  fontMono: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)",
} as const;

export type SmithersUiTokens = typeof tokens;
