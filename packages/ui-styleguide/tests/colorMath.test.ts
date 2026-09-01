/**
 * The two exported color utilities, against WCAG golden vectors and their
 * documented failure modes.
 *
 * Before this file existed neither function had a direct test, and both
 * answered garbage for every non-hex input: `contrastRatio(rgba, ...)` returned
 * `NaN` (which compares `false` against every threshold, so a caller read
 * "fails contrast" instead of "unsupported input"), `mixColors` returned
 * `"#NaNNaNNaN"` (a value a browser drops with no console message), and a fully
 * transparent `#00000000` scored a plausible, maximal, wrong 21:1.
 */
import { describe, expect, test } from "bun:test";
import { contrastRatio, contrastRatioOf, mixChannels, mixColors, themeRegistry } from "../src/index.ts";

describe("contrastRatio", () => {
  test("matches the WCAG anchors", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
    expect(contrastRatio("#ffffff", "#000000")).toBe(21);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
    expect(contrastRatio("#808080", "#ffffff")).toBeCloseTo(3.9494, 4);
  });

  test("reads #rgb and #rrggbb as the same color", () => {
    expect(contrastRatio("#fff", "#000")).toBe(contrastRatio("#ffffff", "#000000"));
    expect(contrastRatio("#abc", "#123")).toBe(contrastRatio("#aabbcc", "#112233"));
  });

  test("accepts #rrggbbaa only when it is opaque", () => {
    expect(contrastRatio("#000000ff", "#ffffff")).toBe(21);
    expect(() => contrastRatio("#00000000", "#ffffff")).toThrow(/opaque foreground/);
    expect(() => contrastRatio("#ffffff", "#00000080")).toThrow(/opaque background/);
  });

  test("names the offending value instead of returning NaN", () => {
    const border = themeRegistry["night-owl"]!.dark.border;
    expect(border).toStartWith("rgba(");
    expect(() => contrastRatio(border, themeRegistry["night-owl"]!.dark.bg)).toThrow(TypeError);
    expect(() => contrastRatio(border, "#ffffff")).toThrow(/rgba\(214,222,235,0\.09\)/);
    for (const bad of ["red", "", "#1234", "#12345", "#123456789", "ffffff", " #ffffff", "#ffffff "]) {
      expect(() => contrastRatio(bad, "#ffffff"), bad).toThrow(TypeError);
    }
  });

  test("does not truncate an over-long hex to a plausible answer", () => {
    // "#123456789".slice(0, 6) used to score as "#123456".
    expect(() => contrastRatio("#123456789", "#ffffff")).toThrow(TypeError);
  });
});

describe("mixColors", () => {
  test("is identity at the endpoints and the midpoint of a known pair", () => {
    expect(mixColors("#ffffff", "#000000", 1)).toBe("#ffffff");
    expect(mixColors("#ffffff", "#000000", 0)).toBe("#000000");
    expect(mixColors("#ffffff", "#000000", 0.5)).toBe("#808080");
    expect(mixColors("#fff", "#000", 0.5)).toBe("#808080");
  });

  test("drops alpha on its inputs, as documented", () => {
    expect(mixColors("#ffffff00", "#000000", 0.5)).toBe(mixColors("#ffffff", "#000000", 0.5));
  });

  test("rejects a non-hex color and an out-of-range amount", () => {
    expect(() => mixColors("red", "#ffffff", 0.5)).toThrow(/received "red"/);
    expect(() => mixColors("rgba(0,0,0,0.5)", "#ffffff", 0.5)).toThrow(TypeError);
    for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, -1, 2, 1.0001]) {
      expect(() => mixColors("#ffffff", "#000000", amount), String(amount)).toThrow(/finite fraction from 0 to 1/);
    }
  });
});

describe("mixChannels", () => {
  test("returns the exact channels the browser computes, not the rounded hex", () => {
    const exact = mixChannels("#64bc9d", "#2f333c", 0.12);
    expect(exact).toEqual([53.36, 67.44, 71.64]);
    expect(mixColors("#64bc9d", "#2f333c", 0.12)).toBe("#354348");
  });

  test("exposes the rounding gap that hid one dark --success below AA", () => {
    // `one` dark: --success on --success-soft. The rounded oracle scored
    // 4.5033 and passed; the browser renders 4.4781.
    const one = themeRegistry.one!.dark;
    const exact = contrastRatioOf(
      [0x64, 0xbc, 0x9d],
      mixChannels(one.success, one.surface, 0.12),
    );
    const rounded = contrastRatio(one.success, mixColors(one.success, one.surface, 0.12));
    expect(exact).toBeLessThan(4.5);
    expect(rounded).toBeGreaterThan(4.5);
    expect(rounded - exact).toBeGreaterThan(0.02);
  });
});
