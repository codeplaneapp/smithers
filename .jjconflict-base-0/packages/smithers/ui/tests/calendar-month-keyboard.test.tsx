/** @jsxImportSource react */
// Month-grid keyboard navigation. The calendar suite had no coverage of it at
// all, which is why Home and End could target Sunday and Saturday regardless of
// `weekStartsOn` while the grid itself was laid out from that prop.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Calendar } from "../src/calendar/Calendar";
import { dayKey } from "../src/calendar/dateUtils";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
});

const at = (iso: string) => Date.parse(`${iso}T00:00:00`);

/** Monday 2026-07-27, inside a month whose grid spans a month boundary. */
const MONDAY = "2026-07-27";
const ANCHOR = at("2026-07-15");

async function renderMonth(weekStartsOn: number): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mounted = root;
  await act(async () =>
    mounted.render(
      <Calendar view="month" events={[]} defaultDate={ANCHOR} now={ANCHOR} weekStartsOn={weekStartsOn} />,
    )
  );
}

function cell(iso: string): HTMLElement {
  const el = container?.querySelector<HTMLElement>(`[data-date="${iso}"]`);
  if (!el) throw new Error(`no cell for ${iso}`);
  return el;
}

async function pressOn(iso: string, key: string): Promise<void> {
  const el = cell(iso);
  await act(async () => el.focus());
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

const focusedDate = () => (document.activeElement as HTMLElement | null)?.getAttribute("data-date");

describe("month grid Home and End follow weekStartsOn", () => {
  test("Sunday-first: Home lands on Sunday and End on Saturday", async () => {
    await renderMonth(0);
    await pressOn(MONDAY, "Home");
    expect(focusedDate()).toBe("2026-07-26");
    await pressOn(MONDAY, "End");
    expect(focusedDate()).toBe("2026-08-01");
  });

  test("Monday-first: Home stays on the focused Monday and End lands on Sunday", async () => {
    await renderMonth(1);
    // The bug: this jumped back to Sunday 2026-07-26, the PREVIOUS visual row.
    await pressOn(MONDAY, "Home");
    expect(focusedDate()).toBe(MONDAY);
    await pressOn(MONDAY, "End");
    expect(focusedDate()).toBe("2026-08-02");
  });

  test("every weekStartsOn value keeps Home and End inside one visible row", async () => {
    for (let weekStartsOn = 0; weekStartsOn < 7; weekStartsOn += 1) {
      await renderMonth(weekStartsOn);
      await pressOn(MONDAY, "Home");
      const home = focusedDate()!;
      await pressOn(MONDAY, "End");
      const end = focusedDate()!;

      const homeMs = at(home);
      const endMs = at(end);
      // A row is exactly seven days, Home first and End last.
      expect(`${weekStartsOn}:${Math.round((endMs - homeMs) / 86_400_000)}`).toBe(`${weekStartsOn}:6`);
      expect(`${weekStartsOn}:${new Date(homeMs).getDay()}`).toBe(`${weekStartsOn}:${weekStartsOn}`);
      // The focused Monday is inside its own row.
      expect(`${weekStartsOn}:${homeMs <= at(MONDAY) && at(MONDAY) <= endMs}`).toBe(`${weekStartsOn}:true`);

      const mounted = root!;
      root = undefined;
      await act(async () => mounted.unmount());
      container?.remove();
      container = undefined;
    }
  });
});

describe("month grid arrow navigation", () => {
  test("arrows move by one day and one week", async () => {
    await renderMonth(0);
    await pressOn(MONDAY, "ArrowRight");
    expect(focusedDate()).toBe("2026-07-28");
    await pressOn(MONDAY, "ArrowLeft");
    expect(focusedDate()).toBe("2026-07-26");
    await pressOn(MONDAY, "ArrowDown");
    expect(focusedDate()).toBe("2026-08-03");
    await pressOn(MONDAY, "ArrowUp");
    expect(focusedDate()).toBe("2026-07-20");
  });

  test("Enter on a day reports the slot", async () => {
    const clicked: string[] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const mounted = root;
    await act(async () =>
      mounted.render(
        <Calendar
          view="month"
          events={[]}
          defaultDate={ANCHOR}
          now={ANCHOR}
          onSlotClick={(ms) => clicked.push(dayKey(ms))}
        />,
      )
    );
    await pressOn(MONDAY, "Enter");
    expect(clicked).toEqual([MONDAY]);
  });
});
