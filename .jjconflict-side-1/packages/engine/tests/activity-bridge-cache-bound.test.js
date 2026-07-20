import { describe, expect, test } from "bun:test";
import {
    COMPLETED_ACTIVITY_RESULTS_MAX,
    completedActivityResultsSize,
    executeTaskActivity,
} from "../src/effect/activity-bridge.js";

const makeDesc = (nodeId) => ({
    nodeId,
    iteration: 1,
    retries: 0,
});

describe("completedActivityResults is bounded", () => {
    test("does not grow past the LRU cap across many runs", async () => {
        const adapter = {};
        const total = COMPLETED_ACTIVITY_RESULTS_MAX + 50;
        for (let i = 0; i < total; i += 1) {
            // distinct runId per iteration => distinct idempotency key
            await executeTaskActivity(
                adapter,
                "workflow",
                `run-${i}`,
                makeDesc("node"),
                () => ({ i }),
            );
        }

        expect(completedActivityResultsSize()).toBeLessThanOrEqual(
            COMPLETED_ACTIVITY_RESULTS_MAX,
        );
    });

    test("retains the most recently cached entry under pressure", async () => {
        const adapter = {};
        const total = COMPLETED_ACTIVITY_RESULTS_MAX + 10;
        for (let i = 0; i < total; i += 1) {
            await executeTaskActivity(
                adapter,
                "workflow",
                `pressure-${i}`,
                makeDesc("node"),
                () => ({ i }),
            );
        }

        // The most recently inserted entry must still be cached: executing it
        // again with a throwing fn must return the cached value, not throw.
        const cached = await executeTaskActivity(
            adapter,
            "workflow",
            `pressure-${total - 1}`,
            makeDesc("node"),
            () => {
                throw new Error("should use cached result");
            },
        );
        expect(cached).toEqual({ i: total - 1 });
    });
});
