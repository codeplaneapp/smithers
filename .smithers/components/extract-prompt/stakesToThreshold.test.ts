import { describe, expect, test } from "bun:test";
import { stakesToThreshold } from "./stakesToThreshold";

describe("stakesToThreshold", () => {
  test("high stakes require a perfect score", () => {
    expect(stakesToThreshold("high")).toBe(1.0);
  });

  test("low stakes are looser", () => {
    expect(stakesToThreshold("low")).toBe(0.7);
  });
});
