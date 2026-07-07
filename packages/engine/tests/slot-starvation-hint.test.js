import { describe, expect, test } from "bun:test";
import { createSlotStarvationHint } from "../src/slotStarvationHint.js";

describe("createSlotStarvationHint", () => {
    test("quiet below the threshold: transient waits produce no hint", () => {
        const hint = createSlotStarvationHint(4);
        expect(hint.onSlotWait(4, 1)).toBeNull();
        expect(hint.onSlotWait(4, 2)).toBeNull();
        expect(hint.onSlotWait(4, 3)).toBeNull();
    });

    test("warns once when queued demand reaches the cap", () => {
        const hint = createSlotStarvationHint(4);
        const message = hint.onSlotWait(4, 4);
        expect(message).toContain("8 tasks want to run concurrently");
        expect(message).toContain("maxConcurrency is 4");
        expect(message).toContain("--max-concurrency 8");
    });

    test("latches: never warns twice per run", () => {
        const hint = createSlotStarvationHint(2);
        expect(hint.onSlotWait(2, 2)).not.toBeNull();
        expect(hint.onSlotWait(2, 5)).toBeNull();
        expect(hint.onSlotWait(2, 50)).toBeNull();
    });

    test("cap of 1 warns as soon as anything queues", () => {
        const hint = createSlotStarvationHint(1);
        expect(hint.onSlotWait(1, 1)).toContain("maxConcurrency is 1");
    });

    test("non-positive cap never warns", () => {
        const hint = createSlotStarvationHint(0);
        expect(hint.onSlotWait(0, 10)).toBeNull();
    });
});
