import { describe, expect, test } from "bun:test";
import { computeRetryDelayMs } from "../src/computeRetryDelayMs.js";

const CAP_MS = 5 * 60 * 1000;

describe("retry delay cap vs oversized initial delays", () => {
  test.each(["fixed", "linear", "exponential"])(
    "%s backoff caps the very first delay when initialDelayMs exceeds the cap",
    (backoff) => {
      const policy = { backoff, initialDelayMs: CAP_MS * 2 };
      expect(computeRetryDelayMs(policy, 1)).toBe(CAP_MS);
    },
  );

  test("an Infinity initialDelayMs still resolves to the finite cap", () => {
    expect(computeRetryDelayMs({ backoff: "fixed", initialDelayMs: Number.POSITIVE_INFINITY }, 1)).toBe(CAP_MS);
  });

  test("initialDelayMs exactly at the cap passes through uncapped", () => {
    expect(computeRetryDelayMs({ backoff: "fixed", initialDelayMs: CAP_MS }, 1)).toBe(CAP_MS);
    expect(computeRetryDelayMs({ backoff: "fixed", initialDelayMs: CAP_MS - 1 }, 3)).toBe(CAP_MS - 1);
  });
});

describe("retry delay at pathological attempt counts", () => {
  test("exponential backoff survives float overflow at huge attempts", () => {
    const policy = { backoff: "exponential", initialDelayMs: 1000 };
    // 2^999 * 1000 overflows to Infinity internally; the cap must hold and the
    // schedule walk must terminate.
    expect(computeRetryDelayMs(policy, 1_000)).toBe(CAP_MS);
  });

  test("linear backoff also holds the cap at huge attempts", () => {
    const policy = { backoff: "linear", initialDelayMs: 1000 };
    expect(computeRetryDelayMs(policy, 10_000)).toBe(CAP_MS);
  });

  test("NaN attempt returns 0 instead of throwing", () => {
    const policy = { backoff: "exponential", initialDelayMs: 1000 };
    // Math.max(1, floor(NaN)) is NaN, so the schedule never steps — the
    // degenerate input degrades to "no delay" rather than crashing the
    // scheduler mid-retry.
    expect(computeRetryDelayMs(policy, Number.NaN)).toBe(0);
  });

  test("Infinity attempt terminates at the bounded schedule walk", () => {
    // Regression: before the MAX_SCHEDULE_STEPS clamp in
    // retryScheduleDelayMs, an Infinity attempt looped forever.
    expect(computeRetryDelayMs({ backoff: "fixed", initialDelayMs: 50 }, Number.POSITIVE_INFINITY)).toBe(50);
    expect(computeRetryDelayMs({ backoff: "exponential", initialDelayMs: 1000 }, Number.POSITIVE_INFINITY)).toBe(
      CAP_MS,
    );
  });
});
