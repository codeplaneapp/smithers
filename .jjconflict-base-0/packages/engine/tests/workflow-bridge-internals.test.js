import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { RetriableTaskFailure } from "../src/effect/activity-bridge.js";
import { __workflowBridgeInternals as I, executeTaskBridgeEffect } from "../src/effect/workflow-bridge.js";

const desc = {
    nodeId: "task",
    iteration: 0,
    retries: 2,
};

describe("workflow bridge internals", () => {
    test("parses attempt error codes and retryable task failures", () => {
        expect(I.parseAttemptErrorCode(null)).toBeNull();
        expect(I.parseAttemptErrorCode("{")).toBeNull();
        expect(I.parseAttemptErrorCode(JSON.stringify({ code: "INVALID_OUTPUT" }))).toBe("INVALID_OUTPUT");
        expect(I.parseAttemptErrorCode(JSON.stringify({ code: 123 }))).toBeNull();

        expect(I.isRetryableBridgeTaskFailure({
            metaJson: JSON.stringify({ failureRetryable: false }),
            errorJson: JSON.stringify({ code: "ANYTHING" }),
        })).toBe(false);
        expect(I.isRetryableBridgeTaskFailure({
            metaJson: JSON.stringify({ kind: "agent" }),
            errorJson: JSON.stringify({ code: "AGENT_CONFIG_INVALID" }),
        })).toBe(false);
        expect(I.isRetryableBridgeTaskFailure({
            metaJson: JSON.stringify({ kind: "static" }),
            errorJson: JSON.stringify({ code: "INVALID_OUTPUT" }),
        })).toBe(false);
        expect(I.isRetryableBridgeTaskFailure({
            metaJson: JSON.stringify({ kind: "agent" }),
            errorJson: JSON.stringify({ code: "INVALID_OUTPUT" }),
        })).toBe(true);
    });

    test("classifies attempts from effect and promise adapters", async () => {
        await expect(I.runEffectOrPromise(Effect.succeed("effect-value"))).resolves.toBe("effect-value");
        await expect(I.runEffectOrPromise(Promise.resolve("promise-value"))).resolves.toBe("promise-value");

        const latestAdapter = {
            listAttempts: () => Effect.succeed([{ attempt: 4, state: "completed" }]),
        };
        await expect(I.getNextTaskActivityAttempt(latestAdapter, "run", desc)).resolves.toBe(5);
        await expect(I.classifyTaskAttempt(latestAdapter, "run", desc, {
            attempt: 1,
            idempotencyKey: "idem",
        })).resolves.toEqual({
            state: "completed",
            attempt: 4,
            idempotencyKey: "idem",
        });

        const emptyAdapter = {
            listAttempts: () => Promise.resolve([]),
        };
        await expect(I.getNextTaskActivityAttempt(emptyAdapter, "run", desc)).resolves.toBe(1);
        await expect(I.classifyTaskAttempt(emptyAdapter, "run", desc, {
            attempt: 3,
            idempotencyKey: "fallback",
        })).resolves.toEqual({
            state: null,
            attempt: 3,
            idempotencyKey: "fallback",
        });
    });

    test("throws retriable failures for retryable failed attempts", async () => {
        const adapter = {
            listAttempts: () => Effect.succeed([
                {
                    attempt: 2,
                    state: "failed",
                    metaJson: JSON.stringify({ kind: "agent" }),
                    errorJson: JSON.stringify({ code: "INVALID_OUTPUT" }),
                },
            ]),
        };
        await expect(I.classifyTaskAttempt(adapter, "run", desc, {
            attempt: 1,
            idempotencyKey: "retry",
        })).rejects.toBeInstanceOf(RetriableTaskFailure);
    });

    test("converts retriable execution errors to non-terminal results", () => {
        expect(I.taskBridgeResultForError(new RetriableTaskFailure("task", 2))).toEqual({ terminal: false });
        const error = new Error("boom");
        expect(() => I.taskBridgeResultForError(error)).toThrow(error);
    });

    test("wraps promise failures in the effect API", async () => {
        const exit = await Effect.runPromiseExit(executeTaskBridgeEffect({}, null, "run", desc, new Map(), null, {}, {}, "wf", false));
        expect(Exit.isFailure(exit)).toBe(true);
    });
});
