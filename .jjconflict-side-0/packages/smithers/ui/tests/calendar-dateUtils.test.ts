import { describe, expect, test } from "bun:test";
import {
  addDays,
  addMonths,
  agendaGroups,
  dayKey,
  daysInMonth,
  eventsOnDay,
  hashSource,
  isSameDay,
  minutesIntoDay,
  monthGridDays,
  snapDown30,
  snapUp30,
  startOfDay,
  weekDays,
} from "../src/calendar/dateUtils";
import type { CalendarEvent } from "../src/calendar/types";

function localDate(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month, day, hour, minute).getTime();
}

function event(id: string, start: number, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id, title: id, start, ...extra };
}

describe("startOfDay / addDays / isSameDay / dayKey", () => {
  test("startOfDay zeroes the wall clock", () => {
    expect(startOfDay(localDate(2026, 6, 27, 15, 42))).toBe(localDate(2026, 6, 27));
  });

  test("addDays preserves the wall clock", () => {
    expect(addDays(localDate(2026, 6, 27, 9, 30), 3)).toBe(localDate(2026, 6, 30, 9, 30));
    expect(addDays(localDate(2026, 6, 27), -7)).toBe(localDate(2026, 6, 20));
  });

  test("isSameDay and dayKey agree", () => {
    expect(isSameDay(localDate(2026, 6, 27, 1), localDate(2026, 6, 27, 23))).toBe(true);
    expect(isSameDay(localDate(2026, 6, 27), localDate(2026, 6, 28))).toBe(false);
    expect(dayKey(localDate(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("addMonths / daysInMonth", () => {
  test("clamps the day-of-month into shorter targets", () => {
    expect(addMonths(localDate(2026, 0, 31), 1)).toBe(localDate(2026, 1, 28));
    expect(addMonths(localDate(2026, 6, 31), -1)).toBe(localDate(2026, 5, 30));
  });

  test("daysInMonth", () => {
    expect(daysInMonth(2026, 1)).toBe(28);
    expect(daysInMonth(2024, 1)).toBe(29);
    expect(daysInMonth(2026, 6)).toBe(31);
  });
});

describe("monthGridDays", () => {
  test("always returns 42 day-starts aligned to midnight", () => {
    const days = monthGridDays(localDate(2026, 6, 15));
    expect(days).toHaveLength(42);
    for (const day of days) expect(day).toBe(startOfDay(day));
    for (let i = 1; i < days.length; i += 1) expect(days[i]).toBe(addDays(days[i - 1]!, 1));
  });

  test("July 2026 (starts Wednesday) leads with June 28 and trails to August 8", () => {
    const days = monthGridDays(localDate(2026, 6, 27));
    expect(days[0]).toBe(localDate(2026, 5, 28));
    expect(days[41]).toBe(localDate(2026, 7, 8));
  });

  test("February 2026 starts exactly on the grid boundary", () => {
    const days = monthGridDays(localDate(2026, 1, 10));
    expect(days[0]).toBe(localDate(2026, 1, 1));
    expect(days[41]).toBe(localDate(2026, 2, 14));
  });

  test("weekStartsOn shifts the leading column", () => {
    const days = monthGridDays(localDate(2026, 6, 27), 1);
    expect(days[0]).toBe(localDate(2026, 5, 29));
    expect(new Date(days[0]!).getDay()).toBe(1);
  });
});

describe("weekDays", () => {
  test("Sunday-start week containing Monday July 27 2026", () => {
    const days = weekDays(localDate(2026, 6, 27, 18));
    expect(days).toHaveLength(7);
    expect(days[0]).toBe(localDate(2026, 6, 26));
    expect(days[6]).toBe(localDate(2026, 7, 1));
  });

  test("Monday-start week", () => {
    const days = weekDays(localDate(2026, 6, 27), 1);
    expect(days[0]).toBe(localDate(2026, 6, 27));
    expect(days[6]).toBe(localDate(2026, 7, 2));
  });
});

describe("agendaGroups", () => {
  test("groups by local day, sorted inside and across groups", () => {
    const groups = agendaGroups([
      event("b-late", localDate(2026, 6, 28, 10)),
      event("a-late", localDate(2026, 6, 27, 12)),
      event("a-early", localDate(2026, 6, 27, 9)),
    ]);
    expect(groups.map((group) => group.dayMs)).toEqual([localDate(2026, 6, 27), localDate(2026, 6, 28)]);
    expect(groups[0]!.events.map((entry) => entry.id)).toEqual(["a-early", "a-late"]);
    expect(groups[1]!.events.map((entry) => entry.id)).toEqual(["b-late"]);
  });

  test("empty input yields no groups", () => {
    expect(agendaGroups([])).toEqual([]);
  });
});

describe("eventsOnDay", () => {
  test("filters to the day and floats all-day events first", () => {
    const dayMs = localDate(2026, 6, 27);
    const events = eventsOnDay(
      [
        event("timed", localDate(2026, 6, 27, 9)),
        event("allday", localDate(2026, 6, 27, 13), { allDay: true }),
        event("other", localDate(2026, 6, 28, 9)),
      ],
      dayMs,
    );
    expect(events.map((entry) => entry.id)).toEqual(["allday", "timed"]);
  });
});

describe("snapping and minutes", () => {
  test("30-minute snap helpers", () => {
    expect(snapDown30(0)).toBe(0);
    expect(snapDown30(29)).toBe(0);
    expect(snapDown30(30)).toBe(30);
    expect(snapDown30(45)).toBe(30);
    expect(snapUp30(30)).toBe(30);
    expect(snapUp30(31)).toBe(60);
    expect(snapUp30(45)).toBe(60);
  });

  test("minutesIntoDay", () => {
    expect(minutesIntoDay(localDate(2026, 6, 27))).toBe(0);
    expect(minutesIntoDay(localDate(2026, 6, 27, 9, 30))).toBe(570);
  });
});

describe("hashSource", () => {
  test("is deterministic and source-sensitive", () => {
    expect(hashSource("implement")).toBe(hashSource("implement"));
    expect(hashSource("implement")).not.toBe(hashSource("review"));
    expect(hashSource(undefined)).toBe(hashSource(""));
  });
});
