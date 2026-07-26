import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { HERDR_SURFACE_EVENT_TYPES } from "../src/index.js";

/**
 * Drift guard for the surface's mapped-event-type set. `HERDR_SURFACE_EVENT_TYPES`
 * is the single source of truth exported from the package (consumers pre-filter an
 * event stream against it before feeding the surface); the `onEvent` switch is the
 * only other place these strings are enumerated. This test pins the two together
 * by scraping the switch's `case` labels straight from source, so adding a case
 * without adding it to the set (or vice versa) fails CI instead of silently
 * dropping — or spuriously parsing — a category of events in every consumer.
 */
describe("HERDR_SURFACE_EVENT_TYPES", () => {
  test("is an exported set of the surface's mapped event types", () => {
    expect(HERDR_SURFACE_EVENT_TYPES instanceof Set).toBe(true);
    expect(HERDR_SURFACE_EVENT_TYPES.size).toBeGreaterThan(0);
    for (const type of HERDR_SURFACE_EVENT_TYPES) {
      expect(typeof type).toBe("string");
    }
  });

  test("exactly matches the onEvent switch cases (no drift in either direction)", () => {
    const src = readFileSync(new URL("../src/createHerdrRunSurface.js", import.meta.url), "utf8");
    // Bound the scrape to the onEvent function body so no unrelated `case` (now
    // or later) can leak in: onEvent is immediately followed by `attach`.
    const start = src.indexOf("function onEvent(event)");
    const end = src.indexOf("async function attach(", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const onEventBody = src.slice(start, end);

    /** @type {Set<string>} */
    const switchCases = new Set();
    for (const match of onEventBody.matchAll(/case\s+"([^"]+)":/g)) {
      switchCases.add(match[1]);
    }

    // Both directions: every switch case is in the set AND every set member has a
    // case. Comparing the sorted arrays reports the exact drift on failure.
    expect([...switchCases].sort()).toEqual([...HERDR_SURFACE_EVENT_TYPES].sort());
  });
});
