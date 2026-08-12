import { describe, expect, test } from "bun:test";
import { contrastRatio, DEFAULT_THEME_KEY, mixColors, serializeThemeVariant, themeRegistry } from "../src";

const SHIKI_IDS = new Set([
  "night-owl", "night-owl-light", "github-dark", "github-light", "one-dark-pro", "one-light",
  "catppuccin-mocha", "catppuccin-latte", "solarized-dark", "solarized-light",
  "gruvbox-dark-medium", "gruvbox-light-medium", "rose-pine", "rose-pine-dawn",
]);

const OLD_FUCORY_LIGHT = "color-scheme:light; font-family:var(--font-sans); --font-sans:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; --font-mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; --bg:#fafafa; --text:#18181b; --text-muted:#52525b; --text-faint:#6d6d75; --text-placeholder:#8a8a93; --surface:#ffffff; --surface-2:#f4f4f5; --surface-3:#ffffff; --surface-glass:rgba(255,255,255,0.72); --surface-glass-strong:rgba(255,255,255,0.85); --border:rgba(24,24,27,0.08); --border-strong:rgba(24,24,27,0.14); --border-solid:#e4e4e7; --hover:#f4f4f5; --hover-subtle:rgba(24,24,27,0.04); --inverse-bg:#18181b; --inverse-text:#fafafa; --code-bg:#18181b; --code-text:#f4f4f5; --inline-code-bg:rgba(24,24,27,0.06); --brand:#6d56d8; --success:#087461; --danger:#c5343f; --warning:#916000; --info:#2a63c9; --shadow-rgb:24 24 27; --shadow-1:0 1px 2px rgb(var(--shadow-rgb) / 0.05); --shadow-2:0 1px 2px rgb(var(--shadow-rgb) / 0.04), 0 8px 24px rgb(var(--shadow-rgb) / 0.07); --shadow-3:0 4px 12px rgb(var(--shadow-rgb) / 0.10), 0 16px 48px rgb(var(--shadow-rgb) / 0.14)";
const OLD_FUCORY_DARK = "color-scheme:dark; --bg:#09090b; --text:#f4f4f5; --text-muted:#a1a1aa; --text-faint:#8c8c95; --text-placeholder:#75757e; --surface:#141417; --surface-2:#1b1b20; --surface-3:#232329; --surface-glass:rgba(20,20,23,0.72); --surface-glass-strong:rgba(20,20,23,0.85); --border:rgba(255,255,255,0.09); --border-strong:rgba(255,255,255,0.16); --border-solid:#2a2a30; --hover:#1f1f24; --hover-subtle:rgba(255,255,255,0.05); --inverse-bg:#f4f4f5; --inverse-text:#18181b; --code-bg:#0c0c0e; --code-text:#e4e4e7; --inline-code-bg:rgba(255,255,255,0.08); --brand:#8b78e6; --success:#2ec9a8; --danger:#f2555a; --warning:#e0a23a; --info:#6aa5f8; --shadow-rgb:0 0 0; --shadow-1:0 1px 2px rgb(var(--shadow-rgb) / 0.35); --shadow-2:0 1px 2px rgb(var(--shadow-rgb) / 0.30), 0 8px 24px rgb(var(--shadow-rgb) / 0.40); --shadow-3:0 4px 12px rgb(var(--shadow-rgb) / 0.45), 0 16px 48px rgb(var(--shadow-rgb) / 0.50)";

describe("theme registry", () => {
  test("contains the complete ordered suite with Night Owl as default", () => {
    expect(DEFAULT_THEME_KEY).toBe("night-owl");
    expect(Object.keys(themeRegistry)).toEqual(["night-owl", "fucory", "one", "github", "catppuccin", "solarized", "gruvbox", "rose-pine"]);
  });

  test("every record has complete matching variants and bundled Shiki ids", () => {
    const keys = Object.keys(themeRegistry[DEFAULT_THEME_KEY].light).sort();
    for (const [key, theme] of Object.entries(themeRegistry)) {
      expect(theme.key).toBe(key);
      expect(Object.keys(theme.light).sort()).toEqual(keys);
      expect(Object.keys(theme.dark).sort()).toEqual(keys);
      expect(SHIKI_IDS.has(theme.syntax.shikiDark)).toBe(true);
      expect(SHIKI_IDS.has(theme.syntax.shikiLight)).toBe(true);
    }
  });

  test("semantic text meets AA on its shared soft tint", () => {
    const amounts = { brand: 0.1, success: 0.12, danger: 0.1, warning: 0.12, info: 0.1 } as const;
    for (const theme of Object.values(themeRegistry)) for (const variant of [theme.light, theme.dark]) {
      for (const [name, amount] of Object.entries(amounts)) {
        const color = variant[name as keyof typeof amounts];
        expect(contrastRatio(color, mixColors(color, variant.surface, amount))).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("preserves the original Fucory token strings", () => {
    expect(serializeThemeVariant(themeRegistry.fucory.light)).toBe(OLD_FUCORY_LIGHT);
    expect(serializeThemeVariant(themeRegistry.fucory.dark)).toBe(OLD_FUCORY_DARK);
  });
});
