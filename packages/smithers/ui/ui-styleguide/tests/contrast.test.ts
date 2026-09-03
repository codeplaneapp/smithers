import { describe, expect, test } from "bun:test";
import { standaloneThemeCss, workflowUiThemeCss } from "../src/index.ts";

type Rgb = readonly [number, number, number];
type ThemeName = "light" | "dark";

const AA_MINIMUM = 4.5;

function parseDeclarations(css: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const match of css.matchAll(/(--[\w-]+):([^;]+)(?:;|$)/g)) {
    declarations.set(match[1]!, match[2]!.trim());
  }
  return declarations;
}

function themeTokens(theme: ThemeName): Map<string, string> {
  const lightBlock = workflowUiThemeCss.match(/^:root \{ ([^}]+) \}/m)?.[1];
  if (!lightBlock) throw new Error("light token block not found");
  const tokens = parseDeclarations(lightBlock);
  if (theme === "light") return tokens;

  const darkBlock = workflowUiThemeCss.match(/:root\[data-theme='dark'\] \{ ([^}]+) \}/)?.[1];
  if (!darkBlock) throw new Error("dark token block not found");
  for (const [name, value] of parseDeclarations(darkBlock)) tokens.set(name, value);
  return tokens;
}

function standaloneTokens(theme: ThemeName): Map<string, string> {
  const css = standaloneThemeCss();
  const lightBlock = css.match(/^:root \{ ([^}]+) \}/m)?.[1];
  if (!lightBlock) throw new Error("standalone light token block not found");
  const tokens = parseDeclarations(lightBlock);
  if (theme === "light") return tokens;

  const darkBlock = css.match(/:root\[data-theme="dark"\] \{ ([^}]+) \}/)?.[1];
  if (!darkBlock) throw new Error("standalone dark token block not found");
  for (const [name, value] of parseDeclarations(darkBlock)) tokens.set(name, value);
  return tokens;
}

function resolveColor(name: string, tokens: Map<string, string>, stack = new Set<string>()): Rgb {
  if (stack.has(name)) throw new Error(`circular token reference: ${name}`);
  stack.add(name);
  const value = tokens.get(name);
  if (!value) throw new Error(`missing color token: ${name}`);

  const hex = value.match(/^#([\da-f]{6})$/i)?.[1];
  if (hex) {
    return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as unknown as Rgb;
  }

  const alias = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  if (alias) return resolveColor(alias, tokens, stack);

  const mix = value.match(/^color-mix\(in srgb,\s*var\((--[\w-]+)\)\s*([\d.]+)%,\s*var\((--[\w-]+)\)\)$/);
  if (mix) {
    const foreground = resolveColor(mix[1]!, tokens, new Set(stack));
    const background = resolveColor(mix[3]!, tokens, new Set(stack));
    const amount = Number(mix[2]) / 100;
    return foreground.map((channel, index) => channel * amount + background[index]! * (1 - amount)) as unknown as Rgb;
  }

  throw new Error(`unsupported color value for ${name}: ${value}`);
}

function relativeLuminance(rgb: Rgb): number {
  const [red, green, blue] = rgb.map((channel) => {
    const encoded = channel / 255;
    return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
  });
  return red! * 0.2126 + green! * 0.7152 + blue! * 0.0722;
}

function contrastRatio(foreground: Rgb, background: Rgb): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("documented text token contrast", () => {
  for (const theme of ["light", "dark"] as const) {
    const semanticPairs = [
      ["--success", "--success-soft"],
      ["--danger", "--danger-soft"],
      ["--warning", "--warning-soft"],
    ] as const;

    for (const [foreground, softBackground] of semanticPairs) {
      for (const background of ["--bg", "--surface", "--surface-2", "--surface-3", softBackground]) {
        test(`${theme} ${foreground} on ${background} meets WCAG AA`, () => {
          const tokens = themeTokens(theme);
          const ratio = contrastRatio(resolveColor(foreground, tokens), resolveColor(background, tokens));
          expect(ratio).toBeGreaterThanOrEqual(AA_MINIMUM);
        });
      }
    }
  }

  for (const background of ["--bg", "--surface", "--surface-2", "--surface-3"] as const) {
    test(`dark --text-faint on ${background} meets WCAG AA`, () => {
      const tokens = themeTokens("dark");
      const ratio = contrastRatio(resolveColor("--text-faint", tokens), resolveColor(background, tokens));
      expect(ratio).toBeGreaterThanOrEqual(AA_MINIMUM);
    });
  }

  test("standalone dark --text-faint on --surface meets WCAG AA", () => {
    const tokens = standaloneTokens("dark");
    const ratio = contrastRatio(resolveColor("--text-faint", tokens), resolveColor("--surface", tokens));
    expect(ratio).toBeGreaterThanOrEqual(AA_MINIMUM);
  });
});
