import { expect, test } from "bun:test";
import {
  clampSplitFraction,
  DEFAULT_SPLIT_FRACTION,
  MAX_SPLIT_FRACTION,
  MIN_SPLIT_FRACTION,
} from "./clampSplitFraction";

test("passes through an in-range fraction", () => {
  expect(clampSplitFraction(0.5)).toBe(0.5);
  expect(clampSplitFraction(0.6)).toBe(0.6);
});

test("clamps below the minimum", () => {
  expect(clampSplitFraction(0.1)).toBe(MIN_SPLIT_FRACTION);
  expect(clampSplitFraction(-2)).toBe(MIN_SPLIT_FRACTION);
});

test("clamps above the maximum", () => {
  expect(clampSplitFraction(0.99)).toBe(MAX_SPLIT_FRACTION);
  expect(clampSplitFraction(5)).toBe(MAX_SPLIT_FRACTION);
});

test("falls back to the default for non-finite input", () => {
  expect(clampSplitFraction(NaN)).toBe(DEFAULT_SPLIT_FRACTION);
  expect(clampSplitFraction(Infinity)).toBe(DEFAULT_SPLIT_FRACTION);
});
