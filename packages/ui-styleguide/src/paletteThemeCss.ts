import { serializeThemeVariant } from "./serializeThemeVariant.ts";
import { DEFAULT_THEME_KEY, themeRegistry } from "./themeRegistry.ts";
import { sharedTokens } from "./themeTokens.ts";

/** Emit both orthogonal theme axes for a chosen quote style. */
export function paletteThemeCss(quote: "'" | '"'): string[] {
  const attr = (name: string, value: string) => `[data-${name}=${quote}${value}${quote}]`;
  const defaults = themeRegistry[DEFAULT_THEME_KEY];
  const rules = [
    `:root { ${serializeThemeVariant(defaults.light)}; ${sharedTokens}; }`,
    `@media (prefers-color-scheme: dark) { :root:not(${attr("theme", "light")}) { ${serializeThemeVariant(defaults.dark)}; } }`,
    `:root${attr("theme", "dark")} { ${serializeThemeVariant(defaults.dark)}; }`,
  ];
  for (const [key, theme] of Object.entries(themeRegistry)) {
    if (key === DEFAULT_THEME_KEY) continue;
    const palette = attr("palette", key);
    rules.push(
      `:root${palette} { ${serializeThemeVariant(theme.light)}; }`,
      `@media (prefers-color-scheme: dark) { :root${palette}:not(${attr("theme", "light")}) { ${serializeThemeVariant(theme.dark)}; } }`,
      `:root${palette}${attr("theme", "dark")} { ${serializeThemeVariant(theme.dark)}; }`,
    );
  }
  return rules;
}
