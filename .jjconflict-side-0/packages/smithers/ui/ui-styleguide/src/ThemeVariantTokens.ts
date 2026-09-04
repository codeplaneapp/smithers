/**
 * The per-variant half of a house theme: exactly the custom properties that
 * change between the light and dark blocks of the emitted styleguide CSS.
 *
 * Theme-invariant properties (font stacks, soft-tint recipes, legacy aliases,
 * geometry) are NOT here. They live once in `sharedTokens` and are emitted a
 * single time regardless of the active theme.
 */
export type ThemeVariantTokens = {
  /** `color-scheme` for the variant. Drives native form and scrollbar chrome. */
  colorScheme: "light" | "dark";
  /** Page background. One elevation step below `surface`. */
  bg: string;
  text: string;
  textMuted: string;
  textFaint: string;
  textPlaceholder: string;
  /** Card surface. */
  surface: string;
  /** Inset / hover surface. */
  surface2: string;
  /** Overlay surface (popovers, dialogs). */
  surface3: string;
  surfaceGlass: string;
  surfaceGlassStrong: string;
  border: string;
  borderStrong: string;
  borderSolid: string;
  hover: string;
  hoverSubtle: string;
  inverseBg: string;
  inverseText: string;
  codeBg: string;
  codeText: string;
  inlineCodeBg: string;
  /** brand = action/active, info = neutral-highlight, success = done, warning = needs-attention, danger = failed. */
  brand: string;
  success: string;
  danger: string;
  warning: string;
  info: string;
  /** Space-separated RGB channels consumed by the `--shadow-*` recipes. */
  shadowRgb: string;
  shadow1: string;
  shadow2: string;
  shadow3: string;
};
