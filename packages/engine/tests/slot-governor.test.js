import { afterEach, describe, expect, test } from "bun:test";
import { createSlotGovernor } from "../src/slotGovernor.js";

const originalCeilingEnv = process.env.SMITHERS_AUTO_MAX_CONCURRENCY_CEILING;
afterEach(() => {
    if (originalCeilingEnv === undefined) {
        delete process.env.SMITHERS_AUTO_MAX_CONCURRENCY_CEILING;
    }
    else {
        process.env.SMITHERS_AUTO_MAX_CONCURRENCY_CEILING = originalCeilingEnv;
    }
});

describe("createSlotGovernor (explicit cap)", () => {
    test("quiet below the threshold: transient waits produce no hint", () => {
        const governor = createSlotGovernor(4, { explicit: true });
        expect(governor.onSlotWait(4, 1)).toEqual({ warn: null, raiseTo: null });
        expect(governor.onSlotWait(4, 2)).toEqual({ warn: null, raiseTo: null });
        expect(governor.onSlotWait(4, 3)).toEqual({ warn: null, raiseTo: null });
    });

    test("warns once when queued demand reaches the cap, never raises", () => {
        const governor = createSlotGovernor(4, { explicit: true });
        const { warn, raiseTo } = governor.onSlotWait(4, 4);
        expect(raiseTo).toBeNull();
        expect(warn).toContain("8 tasks want to run concurrently");
        expect(warn).toContain("maxConcurrency is 4");
        expect(warn).toContain("--max-concurrency 8");
    });

    test("latches: never warns twice per run", () => {
        const governor = createSlotGovernor(2, { explicit: true });
        expect(governor.onSlotWait(2, 2).warn).not.toBeNull();
        expect(governor.onSlotWait(2, 5)).toEqual({ warn: null, raiseTo: null });
        expect(governor.onSlotWait(2, 50)).toEqual({ warn: null, raiseTo: null });
    });

    test("cap of 1 warns as soon as anything queues", () => {
        const governor = createSlotGovernor(1, { explicit: true });
        expect(governor.onSlotWait(1, 1).warn).toContain("maxConcurrency is 1");
    });

    test("non-positive cap never warns nor raises", () => {
        const governor = createSlotGovernor(0, { explicit: true });
        expect(governor.onSlotWait(0, 10)).toEqual({ warn: null, raiseTo: null });
    });
});

describe("createSlotGovernor (auto cap)", () => {
    test("raises to demand on the first queued task, without warning", () => {
        const governor = createSlotGovernor(4, { explicit: false });
        expect(governor.onSlotWait(4, 1)).toEqual({ warn: null, raiseTo: 5 });
    });

    test("raises repeatedly as demand grows, tracking its own raised cap", () => {
        const governor = createSlotGovernor(4, { explicit: false });
        expect(governor.onSlotWait(4, 4).raiseTo).toBe(8);
        // Demand at the raised cap: no further raise, no warn (queue < cap).
        expect(governor.onSlotWait(7, 1)).toEqual({ warn: null, raiseTo: null });
        expect(governor.onSlotWait(8, 4).raiseTo).toBe(12);
    });

    test("clamps raises at the ceiling and never exceeds it", () => {
        const governor = createSlotGovernor(4, { explicit: false, ceiling: 6 });
        expect(governor.onSlotWait(4, 10).raiseTo).toBe(6);
        expect(governor.onSlotWait(6, 3).raiseTo).toBeNull();
    });

    test("warns once when demand keeps growing past an exhausted ceiling", () => {
        const governor = createSlotGovernor(4, { explicit: false, ceiling: 6 });
        expect(governor.onSlotWait(4, 2).raiseTo).toBe(6);
        expect(governor.onSlotWait(6, 5)).toEqual({ warn: null, raiseTo: null });
        const { warn, raiseTo } = governor.onSlotWait(6, 6);
        expect(raiseTo).toBeNull();
        expect(warn).toContain("maxConcurrency is 6");
        expect(governor.onSlotWait(6, 20)).toEqual({ warn: null, raiseTo: null });
    });

    test("cap already at or above the ceiling behaves as pinned", () => {
        const governor = createSlotGovernor(16, { explicit: false, ceiling: 16 });
        expect(governor.onSlotWait(16, 4).raiseTo).toBeNull();
        expect(governor.onSlotWait(16, 16).warn).toContain("maxConcurrency is 16");
    });

    test("non-positive cap never raises", () => {
        const governor = createSlotGovernor(0, { explicit: false });
        expect(governor.onSlotWait(0, 10)).toEqual({ warn: null, raiseTo: null });
    });

    test("reads the ceiling from SMITHERS_AUTO_MAX_CONCURRENCY_CEILING", () => {
        process.env.SMITHERS_AUTO_MAX_CONCURRENCY_CEILING = "5";
        const governor = createSlotGovernor(4, { explicit: false });
        expect(governor.onSlotWait(4, 10).raiseTo).toBe(5);
    });

    test("falls back to a ceiling of 16 when the env var is not a positive int", () => {
        process.env.SMITHERS_AUTO_MAX_CONCURRENCY_CEILING = "banana";
        const governor = createSlotGovernor(4, { explicit: false });
        expect(governor.onSlotWait(4, 20).raiseTo).toBe(16);
    });
});
