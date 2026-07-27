import { describe, expect, test } from "bun:test";
import { statusPillColor, statusPillGlyph, type TuiStatusTone } from "../src/StatusPill.tsx";

const TONES: TuiStatusTone[] = ["ok", "warn", "bad", "muted", "run"];

describe("statusPillGlyph", () => {
  test("returns a non-empty glyph for every tone", () => {
    for (const tone of TONES) {
      expect(statusPillGlyph(tone).length).toBeGreaterThan(0);
    }
  });

  test("uses a hollow ring for the muted tone and filled dots for the rest", () => {
    expect(statusPillGlyph("muted")).toBe("○");
    expect(statusPillGlyph("ok")).toBe("●");
    expect(statusPillGlyph("run")).toBe("◐");
  });
});

describe("statusPillColor", () => {
  test("assigns a distinct hex color to every tone", () => {
    const colors = TONES.map(statusPillColor);
    expect(new Set(colors).size).toBe(TONES.length);
    for (const color of colors) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
