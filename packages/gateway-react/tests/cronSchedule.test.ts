import { describe, expect, test } from "bun:test";
import type { GatewayCronRow } from "@smithers-orchestrator/gateway-client";
import { cronStatus, cronToCalendarEvents, expandCron, parseCronPattern } from "../src/cronSchedule.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function localDate(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month, day, hour, minute).getTime();
}

function cronRow(extra: Partial<GatewayCronRow> = {}): GatewayCronRow {
  return {
    cronId: "cron-1",
    pattern: "0 9 * * *",
    workflowPath: ".smithers/workflows/implement.tsx",
    workflow: "implement",
    enabled: true,
    ...extra,
  };
}

describe("parseCronPattern", () => {
  test("parses the standard 5 fields", () => {
    const parsed = parseCronPattern("30 9 1 7 mon");
    expect(parsed.minute.values.has(30)).toBe(true);
    expect(parsed.hour.values.has(9)).toBe(true);
    expect(parsed.dayOfMonth.values.has(1)).toBe(true);
    expect(parsed.month.values.has(7)).toBe(true);
    expect(parsed.dayOfWeek.values.has(1)).toBe(true);
  });

  test("bare * marks the field unrestricted", () => {
    const parsed = parseCronPattern("* * * * *");
    expect(parsed.minute.any).toBe(true);
    expect(parsed.dayOfMonth.any).toBe(true);
    expect(parsed.dayOfWeek.any).toBe(true);
  });

  test("a stepped star is still restricted", () => {
    expect(parseCronPattern("*/15 * * * *").minute.any).toBe(false);
  });

  test("rejects bad shapes", () => {
    expect(() => parseCronPattern("* * * *")).toThrow();
    expect(() => parseCronPattern("* * * * * *")).toThrow();
    expect(() => parseCronPattern("61 * * * *")).toThrow();
    expect(() => parseCronPattern("*/0 * * * *")).toThrow();
    expect(() => parseCronPattern("9-5 * * * *")).toThrow();
  });
});

describe("expandCron", () => {
  test("every minute over a one-hour window", () => {
    const start = localDate(2026, 6, 27, 9);
    const occurrences = expandCron("* * * * *", start, start + HOUR_MS);
    expect(occurrences).toHaveLength(60);
    expect(occurrences[0]).toBe(start);
    expect(occurrences[59]).toBe(start + 59 * 60_000);
  });

  test("stepped minutes", () => {
    const start = localDate(2026, 6, 27, 9);
    expect(expandCron("*/15 * * * *", start, start + HOUR_MS)).toEqual([
      start,
      start + 15 * 60_000,
      start + 30 * 60_000,
      start + 45 * 60_000,
    ]);
  });

  test("daily at a fixed wall-clock time", () => {
    const start = localDate(2026, 6, 27);
    const occurrences = expandCron("30 9 * * *", start, start + 2 * DAY_MS);
    expect(occurrences).toEqual([localDate(2026, 6, 27, 9, 30), localDate(2026, 6, 28, 9, 30)]);
  });

  test("the window is start-inclusive, end-exclusive", () => {
    const start = localDate(2026, 6, 27, 9, 30);
    expect(expandCron("30 9 * * *", start, start + 1)).toEqual([start]);
    expect(expandCron("30 9 * * *", start + 1, start + DAY_MS)).toEqual([]);
  });

  test("weekday ranges and month names", () => {
    // Monday July 27 - Sunday August 2 2026: weekdays are the 27th-31st.
    const start = localDate(2026, 6, 27);
    const occurrences = expandCron("0 9 * jul mon-fri", start, start + 7 * DAY_MS);
    expect(occurrences).toHaveLength(5);
    expect(occurrences[0]).toBe(localDate(2026, 6, 27, 9));
    expect(occurrences[4]).toBe(localDate(2026, 6, 31, 9));
  });

  test("day-of-month OR day-of-week when both are restricted (Vixie semantics)", () => {
    // July 2026: Wednesdays are 1, 8, 15, 22, 29 — plus the 20th from dom.
    const start = localDate(2026, 6, 19);
    const occurrences = expandCron("0 0 20 * wed", start, start + 7 * DAY_MS);
    expect(occurrences).toEqual([localDate(2026, 6, 20), localDate(2026, 6, 22)]);
  });

  test("restricted to one field matches that field only", () => {
    const start = localDate(2026, 6, 1);
    expect(expandCron("0 0 15 * *", start, start + 31 * DAY_MS)).toEqual([localDate(2026, 6, 15)]);
  });

  test("sunday accepts 0, 7, and sun", () => {
    const start = localDate(2026, 6, 25);
    const end = start + 3 * DAY_MS;
    const expected = [localDate(2026, 6, 26, 9)];
    expect(expandCron("0 9 * * 0", start, end)).toEqual(expected);
    expect(expandCron("0 9 * * 7", start, end)).toEqual(expected);
    expect(expandCron("0 9 * * sun", start, end)).toEqual(expected);
  });

  test("day-of-week ranges ending in Sunday preserve every day in the range", () => {
    const start = localDate(2026, 6, 26); // Sunday
    const end = start + 7 * DAY_MS;
    const atNine = (day: number) => localDate(2026, 6, day, 9);

    expect(expandCron("0 9 * * 0-7", start, end)).toEqual([
      atNine(26),
      atNine(27),
      atNine(28),
      atNine(29),
      atNine(30),
      atNine(31),
      localDate(2026, 7, 1, 9),
    ]);
    expect(expandCron("0 9 * * 1-7", start, end)).toEqual([
      atNine(26),
      atNine(27),
      atNine(28),
      atNine(29),
      atNine(30),
      atNine(31),
      localDate(2026, 7, 1, 9),
    ]);
    const fridayThroughSunday = [atNine(26), atNine(31), localDate(2026, 7, 1, 9)];
    expect(expandCron("0 9 * * 5-7", start, end)).toEqual(fridayThroughSunday);
    expect(expandCron("0 9 * * fri-sun", start, end)).toEqual(fridayThroughSunday);
  });

  test("respects the occurrence limit", () => {
    const start = localDate(2026, 6, 27);
    expect(expandCron("* * * * *", start, start + 7 * DAY_MS, 10)).toHaveLength(10);
  });
});

describe("cronToCalendarEvents", () => {
  test("maps the row onto calendar events", () => {
    const start = localDate(2026, 6, 27);
    const events = cronToCalendarEvents(cronRow(), start, start + 2 * DAY_MS);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      title: "implement",
      start: localDate(2026, 6, 27, 9),
      rrule: "0 9 * * *",
      source: "implement",
      status: "queued",
    });
    expect(events[0]!.id).toBe(`cron-1:${localDate(2026, 6, 27, 9)}`);
  });

  test("status reflects last error and disabled rows", () => {
    expect(cronStatus(cronRow({ errorJson: '{"message":"boom"}' }))).toBe("failed");
    expect(cronStatus(cronRow({ enabled: false }))).toBe("paused");
    expect(cronStatus(cronRow())).toBe("queued");
  });

  test("an invalid pattern degrades to the server-computed nextRunAtMs inside the window", () => {
    const start = localDate(2026, 6, 27);
    const nextRunAtMs = start + 6 * HOUR_MS;
    const events = cronToCalendarEvents(cronRow({ pattern: "not a cron", nextRunAtMs }), start, start + DAY_MS);
    expect(events).toHaveLength(1);
    expect(events[0]!.start).toBe(nextRunAtMs);
    expect(
      cronToCalendarEvents(cronRow({ pattern: "not a cron", nextRunAtMs: start - HOUR_MS }), start, start + DAY_MS),
    ).toEqual([]);
    expect(cronToCalendarEvents(cronRow({ pattern: "not a cron", nextRunAtMs: null }), start, start + DAY_MS)).toEqual(
      [],
    );
  });
});
