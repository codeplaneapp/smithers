import { describe, expect, test } from "bun:test";
import { Schedule } from "effect";
import { retryPolicyToSchedule } from "../src/retryPolicyToSchedule.js";
import { retryScheduleDelayMs } from "../src/retryScheduleDelayMs.js";

describe("retryPolicyToSchedule edge inputs", () => {
  test("returns Schedule.stop when initialDelayMs is 0", () => {
    const schedule = retryPolicyToSchedule({ initialDelayMs: 0 });
    // Schedule.stop yields delay 0 for any attempt because it never retries
    expect(retryScheduleDelayMs(schedule, 1)).toBe(0);
    expect(retryScheduleDelayMs(schedule, 5)).toBe(0);
  });

  test("returns Schedule.stop when initialDelayMs is negative", () => {
    const schedule = retryPolicyToSchedule({ initialDelayMs: -100 });
    expect(retryScheduleDelayMs(schedule, 1)).toBe(0);
  });

  test("returns Schedule.stop when initialDelayMs is undefined", () => {
    const schedule = retryPolicyToSchedule({});
    expect(retryScheduleDelayMs(schedule, 1)).toBe(0);
  });

  test("fixed schedule yields constant delay for every attempt", () => {
    const schedule = retryPolicyToSchedule({
      backoff: "fixed",
      initialDelayMs: 100,
    });
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(retryScheduleDelayMs(schedule, attempt)).toBe(100);
    }
  });

  test("linear schedule grows with attempt count", () => {
    const schedule = retryPolicyToSchedule({
      backoff: "linear",
      initialDelayMs: 100,
    });
    const a1 = retryScheduleDelayMs(schedule, 1);
    const a2 = retryScheduleDelayMs(schedule, 2);
    const a3 = retryScheduleDelayMs(schedule, 3);
    expect(a2).toBeGreaterThan(a1);
    expect(a3).toBeGreaterThan(a2);
  });

  test("exponential schedule grows multiplicatively", () => {
    const schedule = retryPolicyToSchedule({
      backoff: "exponential",
      initialDelayMs: 100,
    });
    const a1 = retryScheduleDelayMs(schedule, 1);
    const a2 = retryScheduleDelayMs(schedule, 2);
    const a3 = retryScheduleDelayMs(schedule, 3);
    expect(a1).toBe(100);
    expect(a2).toBeGreaterThan(a1);
    expect(a3).toBeGreaterThan(a2);
    // ratio between successive delays should be roughly constant (>= 1.5)
    expect(a2 / a1).toBeGreaterThanOrEqual(1.5);
    expect(a3 / a2).toBeGreaterThanOrEqual(1.5);
  });

  test("exponential schedule capped at 5 minutes", () => {
    const cap = 5 * 60 * 1000;
    const schedule = retryPolicyToSchedule({
      backoff: "exponential",
      initialDelayMs: 1000,
    });
    // After many attempts, delay must equal cap
    expect(retryScheduleDelayMs(schedule, 30)).toBe(cap);
  });

  test("returns a real Schedule object (shape check)", () => {
    const schedule = retryPolicyToSchedule({
      backoff: "fixed",
      initialDelayMs: 100,
    });
    expect(Schedule.ScheduleTypeId in schedule).toBe(true);
  });
});
