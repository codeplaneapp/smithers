import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Calendar } from "../src/calendar/Calendar";
import { atMinutesIntoDay, hourLabel, minutesIntoDay, timeLabel } from "../src/calendar/dateUtils";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Pixels per hour in the week grid; mirrors HOUR_PX in Calendar.tsx.
const HOUR_PX = 44;

// America/Los_Angeles springs forward on 2026-03-08 (02:00 -> 03:00) and falls
// back on 2026-11-01 (02:00 -> 01:00), so elapsed time and wall clock disagree
// on both days. Bun re-reads process.env.TZ for Date and Intl on every call.
const previousTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Los_Angeles";
});
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

function wallClock(ms: number): string {
  const d = new Date(ms);
  return `${`${d.getHours()}`.padStart(2, "0")}:${`${d.getMinutes()}`.padStart(2, "0")}`;
}

describe("atMinutesIntoDay across a daylight-saving transition", () => {
  test("a spring-forward day keeps the wall clock the grid drew", () => {
    const springForward = new Date(2026, 2, 8).getTime();
    expect(wallClock(atMinutesIntoDay(springForward, 9 * 60))).toBe("09:00");
    expect(wallClock(atMinutesIntoDay(springForward, 23 * 60 + 30))).toBe("23:30");
  });

  test("an ordinary day is unchanged", () => {
    const ordinary = new Date(2026, 6, 27).getTime();
    expect(atMinutesIntoDay(ordinary, 9 * 60 + 30)).toBe(new Date(2026, 6, 27, 9, 30).getTime());
  });

  test("it inverts minutesIntoDay on every half-hour slot of a transition day", () => {
    const springForward = new Date(2026, 2, 8).getTime();
    const fallBack = new Date(2026, 10, 1).getTime();
    for (const dayMs of [springForward, fallBack]) {
      for (let minutes = 0; minutes <= 23 * 60 + 30; minutes += 30) {
        const slot = atMinutesIntoDay(dayMs, minutes);
        // The spring gap has no wall clock of its own; it resolves forward.
        const expected = dayMs === springForward && minutes >= 120 && minutes < 180 ? minutes + 60 : minutes;
        expect(minutesIntoDay(slot)).toBe(expected);
      }
    }
  });

  test("a nonexistent slot resolves forward and a repeated slot takes its first occurrence", () => {
    expect(wallClock(atMinutesIntoDay(new Date(2026, 2, 8).getTime(), 2 * 60 + 30))).toBe("03:30");
    const repeated = atMinutesIntoDay(new Date(2026, 10, 1).getTime(), 60 + 30);
    expect(wallClock(repeated)).toBe("01:30");
    expect(new Date(repeated).getTimezoneOffset()).toBe(420);
    expect(repeated).toBeLessThan(atMinutesIntoDay(new Date(2026, 10, 1).getTime(), 2 * 60));
  });
});

describe("hourLabel", () => {
  test("labels every hour once, including the hour a transition day skips", () => {
    const labels = Array.from({ length: 24 }, (_, hour) => hourLabel(hour));
    expect(new Set(labels).size).toBe(24);
    expect(labels[2]).toBe(timeLabel(new Date(2001, 0, 1, 2).getTime()));
  });
});

describe("Calendar week view on a daylight-saving transition day", () => {
  test("a click on the 09:00 row reports 09:00 local", async () => {
    const springForward = new Date(2026, 2, 8).getTime();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let clicked: number | undefined;
    try {
      await act(async () => {
        root.render(
          <Calendar
            events={[]}
            view="week"
            date={springForward}
            now={springForward}
            onSlotClick={(ts) => {
              clicked = ts;
            }}
          />,
        );
      });
      const column = container.querySelector(".sui-cal-week-col") as HTMLDivElement;
      await act(async () => {
        column.dispatchEvent(new MouseEvent("click", { bubbles: true, clientY: 9 * HOUR_PX }));
      });
      expect(clicked).toBeDefined();
      expect(wallClock(clicked as number)).toBe("09:00");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("the hour gutter prints each wall-clock hour once", async () => {
    const springForward = new Date(2026, 2, 8).getTime();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<Calendar events={[]} view="week" date={springForward} now={springForward} />);
      });
      const labels = [...container.querySelectorAll(".sui-cal-week-gutter .sui-cal-week-hour")].map(
        (span) => span.textContent ?? "",
      );
      expect(labels).toHaveLength(24);
      expect(labels[0]).toBe("");
      const named = labels.slice(1);
      expect(new Set(named).size).toBe(23);
      expect(named).toContain(timeLabel(new Date(2001, 0, 1, 2).getTime()));
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
