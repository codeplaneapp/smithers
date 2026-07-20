import { describe, expect, test } from "bun:test";
import { nextWallClockInZone } from "../src/BaseCliAgent/nextWallClockInZone.js";

describe("nextWallClockInZone", () => {
    test("resolves 1:30am America/New_York (EDT) to the next 05:30 UTC", () => {
        const fromMs = Date.parse("2025-06-15T12:00:00Z");
        const epoch = nextWallClockInZone({ hour: 1, minute: 30, timeZone: "America/New_York", fromMs });
        expect(epoch).toBe(Date.parse("2025-06-16T05:30:00Z"));
    });

    test("rolls to the next day when the target time already passed today", () => {
        // 09:00 UTC = 05:00 ET; 1:30am ET already passed, so expect tomorrow.
        const fromMs = Date.parse("2025-06-15T09:00:00Z");
        const epoch = nextWallClockInZone({ hour: 1, minute: 30, timeZone: "America/New_York", fromMs });
        expect(epoch).toBe(Date.parse("2025-06-16T05:30:00Z"));
    });

    test("returns a still-future time later today when the target has not passed", () => {
        // 02:00 UTC = 22:00 (prev day) ET; next 1:30am ET is later THIS ET day.
        const fromMs = Date.parse("2025-06-15T02:00:00Z");
        const epoch = nextWallClockInZone({ hour: 1, minute: 30, timeZone: "America/New_York", fromMs });
        expect(epoch).toBe(Date.parse("2025-06-15T05:30:00Z"));
        expect(epoch).toBeGreaterThan(fromMs);
    });

    test("handles standard time (EST, UTC-5) offset", () => {
        const fromMs = Date.parse("2025-01-15T12:00:00Z");
        const epoch = nextWallClockInZone({ hour: 1, minute: 30, timeZone: "America/New_York", fromMs });
        expect(epoch).toBe(Date.parse("2025-01-16T06:30:00Z"));
    });

    test("returns null for an invalid time zone", () => {
        const fromMs = Date.parse("2025-06-15T12:00:00Z");
        expect(nextWallClockInZone({ hour: 1, minute: 30, timeZone: "Not/AZone", fromMs })).toBeNull();
    });
});
