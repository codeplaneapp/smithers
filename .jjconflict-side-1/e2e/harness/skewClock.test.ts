import { afterEach, describe, expect, test } from "bun:test";
import { skewClock, type SkewClockHandle } from "./skewClock";

let active: SkewClockHandle | undefined;

afterEach(() => {
  if (active) {
    active.restore();
    active = undefined;
  }
});

describe("skewClock", () => {
  test("restore() puts Date.now back to the original implementation", () => {
    const originalNow = Date.now;
    active = skewClock(10_000);
    expect(Date.now).not.toBe(originalNow);
    active.restore();
    expect(Date.now).toBe(originalNow);
    active = undefined;
  });

  test("advance(1000) shifts perceived time by exactly 1s", () => {
    active = skewClock(0);
    const before = active.now();
    active.advance(1000);
    const after = active.now();
    expect(after - before).toBeGreaterThanOrEqual(1000);
    expect(after - before).toBeLessThan(1100);
  });

  test("new Date() reflects the skew (Date constructor uses Date.now internally)", () => {
    const realStamp = Date.now();
    active = skewClock(60_000);
    const skewed = new Date().getTime();
    expect(skewed - realStamp).toBeGreaterThanOrEqual(60_000);
    expect(skewed - realStamp).toBeLessThan(60_500);
  });

  test("advance accumulates on top of initial skew", () => {
    active = skewClock(5_000);
    const a = active.now();
    active.advance(2_500);
    const b = active.now();
    expect(b - a).toBeGreaterThanOrEqual(2_500);
    expect(b - a).toBeLessThan(2_600);
  });

  test("restore is idempotent", () => {
    const originalNow = Date.now;
    active = skewClock(1);
    active.restore();
    active.restore();
    expect(Date.now).toBe(originalNow);
    active = undefined;
  });
});
