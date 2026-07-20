import { describe, expect, test } from "bun:test";
import { getToolContext, getToolIdempotencyKey, nextToolSeq, runWithToolContext } from "../src/index.js";

describe("tool-context", () => {
    test("getToolContext is undefined outside a run scope", () => {
        expect(getToolContext()).toBeUndefined();
    });

    test("runWithToolContext makes the context ambient inside fn, including across awaits", async () => {
        const ctx = { runId: "r", nodeId: "n", iteration: 0 };
        await runWithToolContext(ctx, async () => {
            expect(getToolContext()).toBe(ctx);
            await Promise.resolve();
            expect(getToolContext()).toBe(ctx);
        });
        expect(getToolContext()).toBeUndefined();
    });

    test("idempotency key derives from run/node/iteration, honors an explicit key", () => {
        expect(getToolIdempotencyKey()).toBeNull();
        expect(getToolIdempotencyKey({ runId: "r", nodeId: "n", iteration: 3 })).toBe("smithers:r:n:3");
        expect(getToolIdempotencyKey({ idempotencyKey: "custom" })).toBe("custom");
        expect(getToolIdempotencyKey({ runId: "r" })).toBeNull();
    });

    test("idempotency key derives from the ambient context when no ctx is passed", () => {
        const ctx = { runId: "r", nodeId: "n", iteration: 7 };

        runWithToolContext(ctx, () => {
            expect(getToolIdempotencyKey()).toBe("smithers:r:n:7");
        });
    });

    test("idempotency key treats missing or falsey run/node ids as absent", () => {
        expect(getToolIdempotencyKey({ runId: "", nodeId: "n", iteration: 1 })).toBeNull();
        expect(getToolIdempotencyKey({ runId: "r", nodeId: "", iteration: 1 })).toBeNull();
        expect(getToolIdempotencyKey({ runId: 0, nodeId: "n", iteration: 1 })).toBeNull();
        expect(getToolIdempotencyKey({ runId: "r", nodeId: 0, iteration: 1 })).toBeNull();
    });

    test("idempotency key ignores empty or non-string explicit keys", () => {
        expect(getToolIdempotencyKey({ idempotencyKey: "", runId: "r", nodeId: "n", iteration: 2 })).toBe(
            "smithers:r:n:2",
        );
        expect(getToolIdempotencyKey({ idempotencyKey: 123, runId: "r", nodeId: "n", iteration: 2 })).toBe(
            "smithers:r:n:2",
        );
    });

    test("idempotency key defaults nullish iteration to zero without overriding falsey numbers", () => {
        expect(getToolIdempotencyKey({ runId: "r", nodeId: "n" })).toBe("smithers:r:n:0");
        expect(getToolIdempotencyKey({ runId: "r", nodeId: "n", iteration: null })).toBe("smithers:r:n:0");
        expect(getToolIdempotencyKey({ runId: "r", nodeId: "n", iteration: false })).toBe("smithers:r:n:false");
    });

    test("nextToolSeq increments the context's seq", () => {
        const ctx = {};
        expect(nextToolSeq(ctx)).toBe(1);
        expect(nextToolSeq(ctx)).toBe(2);
    });

    test("nextToolSeq increments from existing values and defaults nullish seq to zero", () => {
        const withExistingSeq = { seq: 41 };
        const withNullSeq = { seq: null };
        const withFalseSeq = { seq: false };

        expect(nextToolSeq(withExistingSeq)).toBe(42);
        expect(nextToolSeq(withNullSeq)).toBe(1);
        expect(nextToolSeq(withFalseSeq)).toBe(1);
    });
});
