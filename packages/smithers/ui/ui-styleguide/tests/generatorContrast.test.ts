import { expect, test } from "bun:test";
import { secondaryText } from "../scripts/secondaryText.ts";
import { contrastRatio } from "../src/contrastRatio.ts";

for (const target of [5, 4.75, 4.5]) {
  test(`reports an unreachable secondary text target of ${target}`, () => {
    expect(() => secondaryText("#ffffff", "#ffffff", ["#000000", "#ffffff"], 0.46, target, {
      palette: "unreachable", mode: "light", token: "textPlaceholder",
    })).toThrow(`unreachable/light/textPlaceholder: target ${target}:1, achieved 1.0000:1`);
  });
}

test("checks every background before returning secondary text", () => {
  const backgrounds = ["#ffffff", "#dddddd"];
  const value = secondaryText("#000000", "#ffffff", backgrounds, 0.46, 5, {
    palette: "reachable", mode: "light", token: "textMuted",
  });
  for (const background of backgrounds) expect(contrastRatio(value, background)).toBeGreaterThanOrEqual(5);
});
