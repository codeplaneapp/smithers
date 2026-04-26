import { describe, expect, test } from "bun:test";
import { computeRetryDelayMs } from "../src/computeRetryDelayMs.js";

describe("computeRetryDelayMs", () => {
  test("returns 0 when policy is undefined", () => {
    expect(computeRetryDelayMs(undefined, 1)).toBe(0);
    expect(computeRetryDelayMs(undefined, 5)).toBe(0);
  });

  test("returns 0 when initialDelayMs is missing or zero", () => {
    expect(computeRetryDelayMs({}, 1)).toBe(0);
    expect(computeRetryDelayMs({ initialDelayMs: 0 }, 1)).toBe(0);
    expect(computeRetryDelayMs({ initialDelayMs: -100 }, 1)).toBe(0);
  });

  test("fixed backoff returns same delay for every attempt", () => {
    const policy = { backoff: "fixed", initialDelayMs: 250 };
    expect(computeRetryDelayMs(policy, 1)).toBe(250);
    expect(computeRetryDelayMs(policy, 2)).toBe(250);
    expect(computeRetryDelayMs(policy, 5)).toBe(250);
    expect(computeRetryDelayMs(policy, 100)).toBe(250);
  });

  test("fixed backoff is the default backoff", () => {
    const explicit = { backoff: "fixed", initialDelayMs: 100 };
    const implicit = { initialDelayMs: 100 };
    expect(computeRetryDelayMs(implicit, 1)).toBe(
      computeRetryDelayMs(explicit, 1),
    );
    expect(computeRetryDelayMs(implicit, 5)).toBe(
      computeRetryDelayMs(explicit, 5),
    );
  });

  test("linear backoff is monotonically non-decreasing", () => {
    const policy = { backoff: "linear", initialDelayMs: 100 };
    let prev = -1;
    for (let attempt = 1; attempt <= 6; attempt++) {
      const delay = computeRetryDelayMs(policy, attempt);
      expect(delay).toBeGreaterThanOrEqual(prev);
      prev = delay;
    }
  });

  test("exponential backoff is monotonically non-decreasing until cap", () => {
    const policy = { backoff: "exponential", initialDelayMs: 100 };
    let prev = -1;
    for (let attempt = 1; attempt <= 6; attempt++) {
      const delay = computeRetryDelayMs(policy, attempt);
      expect(delay).toBeGreaterThanOrEqual(prev);
      prev = delay;
    }
  });

  test("exponential backoff starts at the initial delay", () => {
    const policy = { backoff: "exponential", initialDelayMs: 50 };
    expect(computeRetryDelayMs(policy, 1)).toBe(50);
  });

  test("exponential backoff is bounded by 5-minute cap", () => {
    const cap = 5 * 60 * 1000;
    const policy = { backoff: "exponential", initialDelayMs: 1000 };
    // 2^20 * 1000ms ~= 1B ms — far above the cap
    for (let attempt = 1; attempt <= 25; attempt++) {
      expect(computeRetryDelayMs(policy, attempt)).toBeLessThanOrEqual(cap);
    }
    // At a high attempt number, must equal cap
    expect(computeRetryDelayMs(policy, 25)).toBe(cap);
  });

  test("linear backoff respects 5-minute cap", () => {
    const cap = 5 * 60 * 1000;
    const policy = { backoff: "linear", initialDelayMs: 60_000 };
    for (let attempt = 1; attempt <= 20; attempt++) {
      expect(computeRetryDelayMs(policy, attempt)).toBeLessThanOrEqual(cap);
    }
  });

  test("attempt below 1 is treated as attempt=1", () => {
    const policy = { backoff: "fixed", initialDelayMs: 200 };
    expect(computeRetryDelayMs(policy, 0)).toBe(
      computeRetryDelayMs(policy, 1),
    );
    expect(computeRetryDelayMs(policy, -5)).toBe(
      computeRetryDelayMs(policy, 1),
    );
  });

  test("non-integer attempts are floored", () => {
    const policy = { backoff: "linear", initialDelayMs: 100 };
    expect(computeRetryDelayMs(policy, 2.9)).toBe(
      computeRetryDelayMs(policy, 2),
    );
  });

  test("fractional initialDelayMs is floored", () => {
    const policy = { backoff: "fixed", initialDelayMs: 250.9 };
    expect(computeRetryDelayMs(policy, 1)).toBe(250);
  });

  test("output is deterministic — no jitter applied at this layer", () => {
    // The Schedule layer here does not introduce jitter; verify determinism
    // so callers know the bounds are exact, not probabilistic.
    const policy = { backoff: "exponential", initialDelayMs: 100 };
    const a = computeRetryDelayMs(policy, 4);
    const b = computeRetryDelayMs(policy, 4);
    const c = computeRetryDelayMs(policy, 4);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
