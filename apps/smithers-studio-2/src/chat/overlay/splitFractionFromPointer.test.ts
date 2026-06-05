import { expect, test } from "bun:test";
import { splitFractionFromPointer } from "./splitFractionFromPointer";
import { DEFAULT_SPLIT_FRACTION, MAX_SPLIT_FRACTION, MIN_SPLIT_FRACTION } from "./clampSplitFraction";

test("maps a midpoint pointer to a half split", () => {
  // container from x=0 to x=1000, pointer at 500 → 0.5
  expect(splitFractionFromPointer(500, 0, 1000)).toBe(0.5);
});

test("accounts for the container's left offset", () => {
  // container from x=200 to x=1200, pointer at 700 → (700-200)/1000 = 0.5
  expect(splitFractionFromPointer(700, 200, 1000)).toBe(0.5);
});

test("clamps a pointer dragged toward either edge", () => {
  expect(splitFractionFromPointer(0, 0, 1000)).toBe(MIN_SPLIT_FRACTION);
  expect(splitFractionFromPointer(1000, 0, 1000)).toBe(MAX_SPLIT_FRACTION);
});

test("returns the default for a zero-width container", () => {
  expect(splitFractionFromPointer(100, 0, 0)).toBe(DEFAULT_SPLIT_FRACTION);
});
