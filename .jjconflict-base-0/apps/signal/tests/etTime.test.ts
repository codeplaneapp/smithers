import { describe, expect, test } from "bun:test";
import { etClock } from "../scheduler/src/etTime";
import { isPrimaryFireHour, isWatchdogFireTime, timingSafeEqual } from "../scheduler/src/guards";

describe("etClock: DST-correct America/New_York wall clock", () => {
  test("11:00 UTC is 7am ET during EDT (summer)", () => {
    expect(etClock(new Date("2026-07-17T11:00:00.000Z"))).toEqual({ hour: 7, minute: 0, dateEt: "2026-07-17" });
  });

  test("12:00 UTC is 7am ET during EST (winter)", () => {
    expect(etClock(new Date("2026-01-15T12:00:00.000Z"))).toEqual({ hour: 7, minute: 0, dateEt: "2026-01-15" });
  });

  test("12:00 UTC during EDT (summer) is 8am ET, not 7am", () => {
    expect(etClock(new Date("2026-07-17T12:00:00.000Z")).hour).toBe(8);
  });

  test("11:00 UTC during EST (winter) is 6am ET, not 7am", () => {
    expect(etClock(new Date("2026-01-15T11:00:00.000Z")).hour).toBe(6);
  });

  test("spring-forward boundary (2026-03-08, 2am local -> 3am EDT at 07:00 UTC): 7am ET maps to a different UTC hour on each side", () => {
    expect(etClock(new Date("2026-03-07T12:00:00.000Z")).hour).toBe(7); // day before, still EST (UTC-5)
    expect(etClock(new Date("2026-03-08T11:00:00.000Z")).hour).toBe(7); // after the 07:00 UTC jump, EDT (UTC-4)
  });

  test("fall-back boundary (2026-11-01): only the correct UTC hour maps to 7am ET", () => {
    expect(etClock(new Date("2026-10-31T11:00:00.000Z")).hour).toBe(7); // EDT before the fall-back
    expect(etClock(new Date("2026-11-02T12:00:00.000Z")).hour).toBe(7); // EST after the fall-back
  });
});

describe("scheduler cron guards", () => {
  test("isPrimaryFireHour only admits 7am ET", () => {
    expect(isPrimaryFireHour(7)).toBe(true);
    expect(isPrimaryFireHour(6)).toBe(false);
    expect(isPrimaryFireHour(8)).toBe(false);
  });

  test("isWatchdogFireTime only admits 8:15am ET exactly", () => {
    expect(isWatchdogFireTime(8, 15)).toBe(true);
    expect(isWatchdogFireTime(8, 0)).toBe(false);
    expect(isWatchdogFireTime(7, 15)).toBe(false);
  });

  test("one of the two daily primary-cron UTC firings is always 7am ET, year-round", () => {
    const winterHours = [etClock(new Date("2026-01-01T11:00:00.000Z")).hour, etClock(new Date("2026-01-01T12:00:00.000Z")).hour];
    const summerHours = [etClock(new Date("2026-07-01T11:00:00.000Z")).hour, etClock(new Date("2026-07-01T12:00:00.000Z")).hour];
    expect(winterHours.filter((h) => h === 7)).toHaveLength(1);
    expect(summerHours.filter((h) => h === 7)).toHaveLength(1);
  });
});

describe("timingSafeEqual", () => {
  test("returns true for equal strings and false for different ones", async () => {
    expect(await timingSafeEqual("secret-token", "secret-token")).toBe(true);
    expect(await timingSafeEqual("secret-token", "wrong-token")).toBe(false);
    expect(await timingSafeEqual("", "")).toBe(true);
  });
});
