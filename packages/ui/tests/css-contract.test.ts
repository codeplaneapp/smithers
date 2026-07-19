import { describe, expect, test } from "bun:test";
import { workflowUiThemeCss } from "@smithers-orchestrator/ui-styleguide";
import { smithersUiCss } from "../src/uiCss";
import { tokens } from "../src/tokens";

/**
 * The theming contract. These invariants are what make every component
 * correct in light AND dark without any dark-mode code:
 *
 * 1. No `:root` token emission -- the styleguide owns the page tokens, and
 *    its `--primary`/`--accent`/`--muted` aliases have different semantics
 *    than shadcn's. Redefining root tokens would recolor legacy UIs.
 * 2. Every color resolves through `var(--house-token, lightFallback)` or a
 *    `color-mix(in srgb, ...)` over one. Raw hex/rgba outside fallback
 *    position pins a color to one theme (the exact bug class that hit the
 *    operator console's rgba(255,255,255,...) backgrounds).
 * 3. Fallbacks are byte-equal to the styleguide's light values, so components
 *    render the same standalone as under the styleguide in light mode.
 * 4. Every class is `sui-` namespaced.
 */

/** Strip every var(--x, fallback) expression, including rgba fallbacks. */
function stripVarFallbacks(css: string): string {
  return css.replace(/var\(--[\w-]+(?:,\s*(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[\w\s.%-]+))?\)/g, "VAR");
}

describe("css contract", () => {
  test("never emits a :root token block", () => {
    expect(smithersUiCss.includes(":root")).toBe(false);
  });

  test("no raw hex colors outside var() fallback position", () => {
    const stripped = stripVarFallbacks(smithersUiCss);
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("no raw rgb()/rgba() colors: only shadow channels via rgb(var(--shadow-rgb ...))", () => {
    const stripped = stripVarFallbacks(smithersUiCss)
      // The shadow recipe rgb(VAR / a) is the one sanctioned rgb() form.
      .replace(/rgb\(VAR\s*\/\s*[0-9.]+\)/g, "SHADOW")
      .replace(/rgb\(VAR\)/g, "SHADOW");
    expect(stripped).not.toMatch(/rgba?\(/);
  });

  test("all color-mix uses srgb (matches the house recipes; oklab drifts)", () => {
    const mixes = smithersUiCss.match(/color-mix\([^,]+/g) ?? [];
    expect(mixes.length).toBeGreaterThan(0);
    for (const mix of mixes) {
      expect(mix).toStartWith("color-mix(in srgb");
    }
  });

  test("every class is sui- namespaced", () => {
    const classes = smithersUiCss.match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) ?? [];
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls.startsWith(".sui-")).toBe(true);
    }
  });

  test("var() fallbacks are byte-equal to the styleguide light values", () => {
    // Parse the styleguide's light :root block into token -> value.
    const rootBlock = workflowUiThemeCss.split("\n")[0] ?? "";
    const lightValues = new Map<string, string>();
    for (const m of rootBlock.matchAll(/(--[\w-]+):([^;]+);/g)) {
      lightValues.set(m[1]!, m[2]!.trim());
    }
    expect(lightValues.get("--bg")).toBe("#fafafa");

    const sources = [smithersUiCss, Object.values(tokens).filter((v) => typeof v === "string").join("\n")];
    let checked = 0;
    for (const source of sources) {
      for (const m of source.matchAll(/var\((--[\w-]+),\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[\d\s]+)\)/g)) {
        const houseValue = lightValues.get(m[1]!);
        // Tokens not defined by the styleguide (e.g. Radix layout vars) are
        // exempt from the light-parity rule.
        if (houseValue === undefined) continue;
        // Alias tokens (--panel etc.) resolve to var() refs; skip those.
        if (houseValue.startsWith("var(") || houseValue.startsWith("color-mix(")) continue;
        expect(`${m[1]}=${m[2]!.trim()}`).toBe(`${m[1]}=${houseValue}`);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  test("focus ring follows the house recipe (brand 50% border + brand 22% ring)", () => {
    expect(smithersUiCss).toContain("color-mix(in srgb, var(--brand, #6d56d8) 50%, transparent)");
    expect(smithersUiCss).toContain("0 0 0 3px color-mix(in srgb, var(--brand, #6d56d8) 22%, transparent)");
  });

  test("the default button variant is the house tinted primary, not a solid fill", () => {
    const defaultRule = smithersUiCss.match(/\.sui-button-default \{[^}]+\}/)?.[0] ?? "";
    expect(defaultRule).toContain("color-mix(in srgb, var(--brand, #6d56d8) 10%,");
    expect(defaultRule).toContain("color:var(--brand, #6d56d8)");
  });
});
