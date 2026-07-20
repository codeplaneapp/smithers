import { describe, expect, test } from "bun:test";
import * as Activity from "@effect/workflow/Activity";
import { Context, Effect } from "effect";
import {
    executeTaskActivity,
    makeTaskActivity,
    makeTaskBridgeKey,
    RetriableTaskFailure,
} from "../src/effect/activity-bridge.js";

const WorkflowInstanceTag = Context.GenericTag("@effect/workflow/WorkflowEngine/WorkflowInstance");

const desc = {
    nodeId: "activity-node",
    iteration: 1,
    retries: 2,
};

function runActivity(activity, attempt = 1) {
    return Effect.runPromise(activity.execute.pipe(
        Effect.provideService(Activity.CurrentAttempt, attempt),
        Effect.provideService(WorkflowInstanceTag, { executionId: "activity-exec" }),
    ));
}

describe("activity bridge internals", () => {
    test("runs Activity.make wrappers with attempt-aware idempotency keys", async () => {
        const activity = makeTaskActivity(desc, (context) => ({
            attempt: context.attempt,
            hasAttemptKey: context.idempotencyKey.length > 0,
        }), { includeAttemptInIdempotencyKey: true });

        await expect(runActivity(activity, 3)).resolves.toEqual({
            attempt: 3,
            hasAttemptKey: true,
        });
    });

    test("maps activity execution promise failures", async () => {
        const error = new Error("activity failed");
        const activity = makeTaskActivity(desc, () => {
            throw error;
        });
        await expect(runActivity(activity)).rejects.toThrow("activity failed");
    });

    test("retries and caches direct task activity execution", async () => {
        const adapter = {};
        const key = makeTaskBridgeKey(adapter, "workflow", "run", desc);
        expect(key).toContain("activity-node");

        let calls = 0;
        const result = await executeTaskActivity(adapter, "workflow", "run", desc, ({ attempt }) => {
            calls += 1;
            if (attempt < 2) {
                throw new RetriableTaskFailure(desc.nodeId, attempt);
            }
            return { attempt };
        }, { includeAttemptInIdempotencyKey: true });
        expect(result).toEqual({ attempt: 2 });
        expect(calls).toBe(2);

        const cached = await executeTaskActivity(adapter, "workflow", "run", desc, () => {
            throw new Error("should use cached result");
        }, { initialAttempt: 2, includeAttemptInIdempotencyKey: true });
        expect(cached).toEqual({ attempt: 2 });
    });
});
