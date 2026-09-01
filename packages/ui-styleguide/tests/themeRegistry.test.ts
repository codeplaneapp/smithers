import { describe, expect, test } from "bun:test";
import { contrastRatio, DEFAULT_THEME_KEY, serializeThemeVariant, themeRegistry } from "../src/index.ts";
import {
  AA_MINIMUM,
  KNOWN_CONTRAST_GAPS,
  KNOWN_RAMP_COLLAPSES,
  KNOWN_ROLE_COLLISIONS,
  KNOWN_TERMINAL_GAPS,
  PAINTED_PAIRS,
  ratioFor,
  SEMANTICS,
  TEXT_RAMP,
} from "./paintedPairs.ts";

const SHIKI_IDS = new Set([
  "night-owl",
  "night-owl-light",
  "github-dark",
  "github-light",
  "one-dark-pro",
  "one-light",
  "catppuccin-mocha",
  "catppuccin-latte",
  "solarized-dark",
  "solarized-light",
  "gruvbox-dark-medium",
  "gruvbox-light-medium",
  "rose-pine",
  "rose-pine-dawn",
]);

const FUCORY_LIGHT =
  "color-scheme:light; --bg:#fafafa; --text:#18181b; --text-muted:#52525b; --text-faint:#6d6d75; --text-placeholder:#6f6f78; --surface:#ffffff; --surface-2:#f4f4f5; --surface-3:#ffffff; --surface-glass:rgba(255,255,255,0.72); --surface-glass-strong:rgba(255,255,255,0.85); --border:rgba(24,24,27,0.08); --border-strong:rgba(24,24,27,0.14); --border-solid:#e4e4e7; --hover:#f4f4f5; --hover-subtle:rgba(24,24,27,0.04); --inverse-bg:#18181b; --inverse-text:#fafafa; --code-bg:#f4f4f5; --code-text:#18181b; --inline-code-bg:rgba(24,24,27,0.06); --brand:#6d56d8; --success:#087461; --danger:#c5343f; --warning:#916000; --info:#2a63c9; --shadow-rgb:24 24 27; --shadow-1:0 1px 2px rgb(var(--shadow-rgb) / 0.05); --shadow-2:0 1px 2px rgb(var(--shadow-rgb) / 0.04), 0 8px 24px rgb(var(--shadow-rgb) / 0.07); --shadow-3:0 4px 12px rgb(var(--shadow-rgb) / 0.10), 0 16px 48px rgb(var(--shadow-rgb) / 0.14)";
const FUCORY_DARK =
  "color-scheme:dark; --bg:#09090b; --text:#f4f4f5; --text-muted:#a1a1aa; --text-faint:#8c8c95; --text-placeholder:#8a8a93; --surface:#141417; --surface-2:#1b1b20; --surface-3:#232329; --surface-glass:rgba(20,20,23,0.72); --surface-glass-strong:rgba(20,20,23,0.85); --border:rgba(255,255,255,0.09); --border-strong:rgba(255,255,255,0.16); --border-solid:#2a2a30; --hover:#1f1f24; --hover-subtle:rgba(255,255,255,0.05); --inverse-bg:#f4f4f5; --inverse-text:#18181b; --code-bg:#0c0c0e; --code-text:#e4e4e7; --inline-code-bg:rgba(255,255,255,0.08); --brand:#8e7ce8; --success:#2ec9a8; --danger:#f2555a; --warning:#e0a23a; --info:#6aa5f8; --shadow-rgb:0 0 0; --shadow-1:0 1px 2px rgb(var(--shadow-rgb) / 0.35); --shadow-2:0 1px 2px rgb(var(--shadow-rgb) / 0.30), 0 8px 24px rgb(var(--shadow-rgb) / 0.40); --shadow-3:0 4px 12px rgb(var(--shadow-rgb) / 0.45), 0 16px 48px rgb(var(--shadow-rgb) / 0.50)";

const variants = Object.entries(themeRegistry).flatMap(([key, theme]) =>
  (["light", "dark"] as const).map((mode) => ({ key, mode, variant: theme[mode] }))
);

describe("theme registry", () => {
  test("contains the complete ordered suite with Night Owl as default", () => {
    expect(DEFAULT_THEME_KEY).toBe("night-owl");
    expect(Object.keys(themeRegistry)).toEqual([
      "night-owl",
      "fucory",
      "one",
      "github",
      "catppuccin",
      "solarized",
      "gruvbox",
      "rose-pine",
    ]);
  });

  test("every record has complete matching variants and bundled Shiki ids", () => {
    const keys = Object.keys(themeRegistry[DEFAULT_THEME_KEY]!.light).sort();
    for (const [key, theme] of Object.entries(themeRegistry)) {
      expect(theme.key).toBe(key);
      expect(Object.keys(theme.light).sort()).toEqual(keys);
      expect(Object.keys(theme.dark).sort()).toEqual(keys);
      expect(Object.keys(theme.terminal.light).sort()).toEqual(
        Object.keys(themeRegistry[DEFAULT_THEME_KEY]!.terminal.light).sort(),
      );
      expect(Object.keys(theme.terminal.dark).sort()).toEqual(
        Object.keys(themeRegistry[DEFAULT_THEME_KEY]!.terminal.dark).sort(),
      );
      expect(SHIKI_IDS.has(theme.syntax.shikiDark)).toBe(true);
      expect(SHIKI_IDS.has(theme.syntax.shikiLight)).toBe(true);
    }
  });

  test("is deeply frozen, so both CSS emitters answer from one snapshot", () => {
    expect(Object.isFrozen(themeRegistry)).toBe(true);
    for (const { variant } of variants) expect(Object.isFrozen(variant)).toBe(true);
    for (const theme of Object.values(themeRegistry)) {
      expect(Object.isFrozen(theme)).toBe(true);
      expect(Object.isFrozen(theme.terminal)).toBe(true);
      expect(Object.isFrozen(theme.terminal.dark)).toBe(true);
    }
    const target = themeRegistry[DEFAULT_THEME_KEY]!.light;
    const before = target.bg;
    expect(() => {
      (target as { bg: string }).bg = "#123456";
    }).toThrow(TypeError);
    expect(themeRegistry[DEFAULT_THEME_KEY]!.light.bg).toBe(before);
  });
});

describe("WCAG AA on every pair the stylesheets paint", () => {
  // No `continue`, no guard: every palette, every mode, every pair. Failures
  // that this package cannot fix at the source are enumerated in
  // `KNOWN_CONTRAST_GAPS`, and the second assertion below retires an entry the
  // moment its pair starts passing.
  for (const { key, mode, variant } of variants) {
    for (const pair of PAINTED_PAIRS) {
      const id = `${key}/${mode}/${pair.label}`;
      const known = KNOWN_CONTRAST_GAPS.get(id);
      if (known === undefined) {
        test(`${id} meets AA`, () => {
          expect(ratioFor(pair, variant)).toBeGreaterThanOrEqual(AA_MINIMUM);
        });
        continue;
      }
      test(`${id} is a recorded upstream gap, still failing at ${known}`, () => {
        const ratio = ratioFor(pair, variant);
        expect(ratio).toBeLessThan(AA_MINIMUM);
        expect(ratio).toBeCloseTo(known, 3);
      });
    }
  }

  test("no recorded gap names a pair the table no longer paints", () => {
    const painted = new Set(variants.flatMap(({ key, mode }) => PAINTED_PAIRS.map((p) => `${key}/${mode}/${p.label}`)));
    for (const id of KNOWN_CONTRAST_GAPS.keys()) expect(painted.has(id)).toBe(true);
  });

  test("every terminal palette is legible on its own background", () => {
    for (const [key, theme] of Object.entries(themeRegistry)) {
      for (const mode of ["light", "dark"] as const) {
        const palette = theme.terminal[mode];
        const ratio = contrastRatio(palette.foreground, palette.background);
        const known = KNOWN_TERMINAL_GAPS.get(`${key}/${mode}`);
        if (known === undefined) expect(ratio, `${key}/${mode} terminal`).toBeGreaterThanOrEqual(AA_MINIMUM);
        else expect(ratio, `${key}/${mode} terminal`).toBeLessThan(AA_MINIMUM);
      }
    }
  });
});

describe("theme vocabulary", () => {
  test("keeps every semantic role pairwise distinct", () => {
    for (const { key, mode, variant } of variants) {
      for (let i = 0; i < SEMANTICS.length; i++) {
        for (let j = i + 1; j < SEMANTICS.length; j++) {
          const [a, b] = [SEMANTICS[i]!, SEMANTICS[j]!];
          const id = `${key}/${mode}/${a}=${b}`;
          const same = variant[a].toLowerCase() === variant[b].toLowerCase();
          expect(same, `${id} (${variant[a]} vs ${variant[b]})`).toBe(KNOWN_ROLE_COLLISIONS.has(id));
        }
      }
    }
  });

  test("every recorded gap names a variant that still exists", () => {
    const ids = new Set(variants.map(({ key, mode }) => `${key}/${mode}`));
    for (const id of KNOWN_TERMINAL_GAPS.keys()) expect(ids.has(id), id).toBe(true);
    for (const id of [...KNOWN_RAMP_COLLAPSES, ...KNOWN_ROLE_COLLISIONS]) {
      expect(ids.has(id.split("/").slice(0, 2).join("/")), id).toBe(true);
    }
  });

  test("grades the secondary text ramp with a strict step, not a flat line", () => {
    for (const { key, mode, variant } of variants) {
      for (let i = 0; i + 1 < TEXT_RAMP.length; i++) {
        const [stronger, weaker] = [TEXT_RAMP[i]!, TEXT_RAMP[i + 1]!];
        const id = `${key}/${mode}/${stronger} > ${weaker}`;
        const graded = contrastRatio(variant[stronger], variant.bg) > contrastRatio(variant[weaker], variant.bg);
        expect(graded, id).toBe(!KNOWN_RAMP_COLLAPSES.has(id));
      }
    }
  });

  test("keeps the surface elevation ramp ordered in both modes", () => {
    const luminanceAgainstBlack = (color: string) => contrastRatio(color, "#000000");
    for (const theme of Object.values(themeRegistry)) {
      expect(luminanceAgainstBlack(theme.light.surface)).toBeGreaterThanOrEqual(luminanceAgainstBlack(theme.light.bg));
      expect(luminanceAgainstBlack(theme.light.surface2)).toBeLessThan(luminanceAgainstBlack(theme.light.surface));
      expect(luminanceAgainstBlack(theme.light.surface3)).toBeGreaterThanOrEqual(
        luminanceAgainstBlack(theme.light.surface),
      );
      expect(luminanceAgainstBlack(theme.dark.surface)).toBeGreaterThan(luminanceAgainstBlack(theme.dark.bg));
      expect(luminanceAgainstBlack(theme.dark.surface2)).toBeGreaterThan(luminanceAgainstBlack(theme.dark.surface));
      expect(luminanceAgainstBlack(theme.dark.surface3)).toBeGreaterThan(luminanceAgainstBlack(theme.dark.surface2));
    }
    expect(luminanceAgainstBlack(themeRegistry[DEFAULT_THEME_KEY]!.light.surface)).toBeGreaterThan(
      luminanceAgainstBlack(themeRegistry[DEFAULT_THEME_KEY]!.light.bg),
    );
  });

  test("serializes Fucory to its accessibility-corrected token strings", () => {
    expect(serializeThemeVariant(themeRegistry.fucory!.light)).toBe(FUCORY_LIGHT);
    expect(serializeThemeVariant(themeRegistry.fucory!.dark)).toBe(FUCORY_DARK);
  });
});
