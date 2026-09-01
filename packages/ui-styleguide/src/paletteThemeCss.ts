import { serializeThemeVariant } from "./serializeThemeVariant.ts";
import { DEFAULT_THEME_KEY, findTheme, themeRegistry } from "./themeRegistry.ts";
import { sharedTokens } from "./themeTokens.ts";

/** Options for {@link paletteThemeCss}. */
export type PaletteThemeCssOptions = {
  /**
   * Which palettes to emit override rules for, in registry order. Defaults to
   * every registered key. The default palette's own rules are always emitted,
   * because they carry the shared tokens and the font block.
   */
  palettes?: readonly string[];
};

/**
 * Emit both orthogonal theme axes for a chosen quote style.
 *
 * Rule order is load-bearing. `:root[data-palette='<key>']` and the default's
 * `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) }`
 * both compute to specificity (0,2,0), so only source order stops the default's
 * dark tokens from overriding a selected palette's light tokens. The three
 * default rules come first; every palette's three rules come after.
 *
 * @throws {RangeError} when `palettes` names a key the registry does not have.
 */
export function paletteThemeCss(quote: "'" | '"', options: PaletteThemeCssOptions = {}): string[] {
  const attr = (name: string, value: string) => `[data-${name}=${quote}${value}${quote}]`;
  const defaults = themeRegistry[DEFAULT_THEME_KEY];
  const rules = [
    `:root { ${serializeThemeVariant(defaults.light, { fonts: true })}; ${sharedTokens}; }`,
    `@media (prefers-color-scheme: dark) { :root:not(${attr("theme", "light")}) { ${
      serializeThemeVariant(defaults.dark)
    }; } }`,
    `:root${attr("theme", "dark")} { ${serializeThemeVariant(defaults.dark)}; }`,
  ];
  // Validate first, then walk the registry rather than the caller's array, so a
  // reordered or repeated request still emits each palette once in registry
  // order. Two callers asking for the same set get byte-identical CSS.
  const requested = new Set(options.palettes ?? Object.keys(themeRegistry));
  for (const key of requested) {
    if (findTheme(key) === undefined) {
      throw new RangeError(
        `unknown palette ${JSON.stringify(key)}; registered: ${Object.keys(themeRegistry).join(", ")}`,
      );
    }
  }
  for (const [key, theme] of Object.entries(themeRegistry)) {
    if (key === DEFAULT_THEME_KEY || !requested.has(key)) continue;
    const palette = attr("palette", key);
    rules.push(
      `:root${palette} { ${serializeThemeVariant(theme.light)}; }`,
      `@media (prefers-color-scheme: dark) { :root${palette}:not(${attr("theme", "light")}) { ${
        serializeThemeVariant(theme.dark)
      }; } }`,
      `:root${palette}${attr("theme", "dark")} { ${serializeThemeVariant(theme.dark)}; }`,
    );
  }
  return rules;
}
