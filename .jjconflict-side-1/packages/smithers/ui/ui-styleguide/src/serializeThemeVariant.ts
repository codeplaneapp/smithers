import type { ThemeVariantTokens } from "./ThemeVariantTokens.ts";

/**
 * Font stacks. Sans carries the UI; mono is reserved for code, ids, and
 * tabular data. Never set body copy in mono. These are theme-invariant, so
 * exactly one rule in the emitted sheet declares them.
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
 * Anything that would end the declaration, end the rule, open a comment, or
 * escape the surrounding `<style>` element. A token value carrying one of
 * these is not a color, and interpolating it would let the caller write CSS or
 * markup the emitter never intended. `/` and `(` stay legal because the shadow
 * recipes are `rgb(var(--shadow-rgb) / 0.05)`.
 */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects.
const CSS_UNSAFE = /[;{}<>\\@"']|\/\*|[\u0000-\u001F\u007F]/;

/** Long enough for the widest shipped shadow recipe, short enough to be a cap. */
const MAX_TOKEN_LENGTH = 160;

function checkedValue(variant: ThemeVariantTokens, property: string, key: keyof ThemeVariantTokens): string {
  const descriptor = Object.getOwnPropertyDescriptor(variant, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError(`theme token ${property} must be an own data property, none found for ${String(key)}`);
  }
  const value: unknown = descriptor.value;
  if (typeof value !== "string") {
    throw new TypeError(`theme token ${property} must be a string, received ${JSON.stringify(value)}`);
  }
  if (value.length === 0 || value.length > MAX_TOKEN_LENGTH) {
    throw new TypeError(
      `theme token ${property} must be 1 to ${MAX_TOKEN_LENGTH} characters, received ${value.length}`,
    );
  }
  if (CSS_UNSAFE.test(value)) {
    throw new TypeError(`theme token ${property} contains a CSS or markup delimiter: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Options for {@link serializeThemeVariant}. */
export type SerializeThemeVariantOptions = {
  /**
   * Emit the theme-invariant font block alongside the colors. Exactly one rule
   * in a stylesheet should do this; every other rule restates colors only.
   * Defaults to `false`, so a caller serializing a palette override never
   * out-ranks a consumer's own bare-`:root` font declarations.
   */
  fonts?: boolean;
};

/**
 * Turn one theme variant into the joined declaration string the styleguide
 * injects.
 *
 * The caller decides whether the theme-invariant font block rides along: the
 * emitted palette rules are `:root[data-palette='<key>']`, specificity (0,2,0),
 * so restating fonts there would beat a consumer's own `:root` overrides. Only
 * the base `:root` rule passes `fonts: true`.
 *
 * Values are read as data-only own properties and validated: every token must
 * be a non-empty string of at most `MAX_TOKEN_LENGTH` (160) characters with no
 * CSS or markup delimiter, because the result is interpolated into a stylesheet
 * verbatim.
 *
 * @throws {TypeError} when a token is missing, is not a string, is too long, or
 *   carries a delimiter.
 */
export function serializeThemeVariant(
  variant: ThemeVariantTokens,
  options: SerializeThemeVariantOptions = {},
): string {
  const scheme = checkedValue(variant, "color-scheme", "colorScheme");
  if (scheme !== "light" && scheme !== "dark") {
    throw new TypeError(`theme color-scheme must be "light" or "dark", received ${JSON.stringify(scheme)}`);
  }
  const declarations = [`color-scheme:${scheme}`];
  if (options.fonts === true) declarations.push(...FONT_DECLARATIONS);
  for (const [property, key] of TOKEN_ORDER) {
    declarations.push(`${property}:${checkedValue(variant, property, key)}`);
  }
  return declarations.join("; ");
}
