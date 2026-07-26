import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
    defineTool,
    getDefinedToolMetadata,
    getToolContext,
    getToolIdempotencyKey,
    nextToolSeq,
    runWithToolContext,
} from "../src/index.js";

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

    test("rejects revert without sideEffect:true at definition time", () => {
        expect(() => defineTool({
            name: "invalid-revert",
            schema: z.object({ id: z.string() }),
            execute: async () => "ok",
            revert: async () => {},
        })).toThrow("revert requires sideEffect:true");
    });

    test("stamps hasRevert and preserves the revert handler with the documented context shape", async () => {
        const seen = [];
        const revert = async (args, ctx) => {
            seen.push({ args, ctx });
        };
        const defined = defineTool({
            name: "revertible-send",
            schema: z.object({ channel: z.string() }),
            sideEffect: true,
            idempotent: false,
            execute: async (_args, _ctx) => ({ messageId: "m-1" }),
            revert,
        });

        const metadata = getDefinedToolMetadata(defined);
        expect(metadata).toMatchObject({
            name: "revertible-send",
            sideEffect: true,
            idempotent: false,
            acceptsIdempotencyKey: true,
            hasRevert: true,
            revert,
        });

        const ctx = {
            output: { messageId: "m-1" },
            effectStatus: "succeeded",
            idempotencyKey: "effect-key",
            runId: "run-1",
            nodeId: "announce",
            iteration: 2,
            attempt: 3,
            toolCallSeq: 4,
        };
        await metadata.revert({ channel: "alerts" }, ctx);
        expect(seen).toEqual([{ args: { channel: "alerts" }, ctx }]);
    });

    test.each([
        ["finished", async () => ({ ok: true }), "succeeded"],
        ["failed", async () => { throw new Error("send failed"); }, "unknown"],
    ])("stamps provenance on every %s journal phase", async (_label, execute, terminalStatus) => {
        const calls = [];
        const defined = defineTool({
            name: "journalled-send",
            schema: z.object({ value: z.number() }),
            sideEffect: true,
            idempotent: false,
            execute: async (args, ctx) => execute(args, ctx),
            revert: async () => {},
        });
        const invocation = runWithToolContext({
            runId: "run-1",
            nodeId: "task-1",
            iteration: 2,
            attempt: 3,
            recordToolCall: (call) => calls.push(call),
        }, () => defined.execute({ value: 1 }, {}));

        if (terminalStatus === "unknown") {
            await expect(invocation).rejects.toThrow("send failed");
        }
        else {
            await expect(invocation).resolves.toEqual({ ok: true });
        }

        expect(calls.map((call) => call.phase)).toEqual(["started", _label]);
        for (const call of calls) {
            expect(call).toMatchObject({
                kind: "tool",
                toolName: "journalled-send",
                sideEffect: true,
                idempotent: false,
                acceptsIdempotencyKey: true,
                hasRevert: true,
                idempotencyKey: "smithers:run-1:task-1:2",
            });
        }
        expect(calls.at(-1).effectStatus).toBe(terminalStatus);
    });
});
