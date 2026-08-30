import type { ThemeVariantTokens } from "./ThemeVariantTokens.ts";

/**
 * Font stacks. Sans carries the UI; mono is reserved for code, ids, and
 * tabular data. Never set body copy in mono. These are theme-invariant, so
 * they are emitted once, with the light variant that opens every `:root` block.
 */
const FONT_DECLARATIONS = [
  "font-family:var(--font-sans)",
  "--font-sans:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
  "--font-mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace",
];

/** Emission order of the per-variant custom properties. */
const TOKEN_ORDER: readonly (readonly [string, keyof ThemeVariantTokens])[] = [
  ["--bg", "bg"],
  ["--text", "text"],
  ["--text-muted", "textMuted"],
  ["--text-faint", "textFaint"],
  ["--text-placeholder", "textPlaceholder"],
  ["--surface", "surface"],
  ["--surface-2", "surface2"],
  ["--surface-3", "surface3"],
  ["--surface-glass", "surfaceGlass"],
  ["--surface-glass-strong", "surfaceGlassStrong"],
  ["--border", "border"],
  ["--border-strong", "borderStrong"],
  ["--border-solid", "borderSolid"],
  ["--hover", "hover"],
  ["--hover-subtle", "hoverSubtle"],
  ["--inverse-bg", "inverseBg"],
  ["--inverse-text", "inverseText"],
  ["--code-bg", "codeBg"],
  ["--code-text", "codeText"],
  ["--inline-code-bg", "inlineCodeBg"],
  ["--brand", "brand"],
  ["--success", "success"],
  ["--danger", "danger"],
  ["--warning", "warning"],
  ["--info", "info"],
  ["--shadow-rgb", "shadowRgb"],
  ["--shadow-1", "shadow1"],
  ["--shadow-2", "shadow2"],
  ["--shadow-3", "shadow3"],
];

/**
 * Turn one theme variant into the joined declaration string the styleguide
 * injects. The light variant carries the theme-invariant font block because it
 * opens the base `:root` rule; dark and palette-override blocks only restate
 * the colors.
 */
export function serializeThemeVariant(variant: ThemeVariantTokens): string {
  const declarations = [`color-scheme:${variant.colorScheme}`];
  if (variant.colorScheme === "light") declarations.push(...FONT_DECLARATIONS);
  for (const [property, key] of TOKEN_ORDER) declarations.push(`${property}:${variant[key]}`);
  return declarations.join("; ");
}
