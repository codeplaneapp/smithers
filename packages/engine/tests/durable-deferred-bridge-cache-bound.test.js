import { describe, expect, test } from "bun:test";
import {
    DEFERRED_RESOLUTIONS_MAX,
    bridgeApprovalResolve,
    deferredResolutionsSize,
} from "../src/effect/durable-deferred-bridge.js";

describe("deferredResolutions is bounded", () => {
    test("does not grow past the LRU cap across many stored-but-never-consumed resolutions", async () => {
        const adapter = {};
        const total = DEFERRED_RESOLUTIONS_MAX + 50;
        for (let i = 0; i < total; i += 1) {
            // distinct runId per iteration => distinct execution id; never
            // consumed via awaitBridgeDeferred, simulating a run that was
            // cancelled or abandoned after its resolution was stored.
            await bridgeApprovalResolve(adapter, `run-${i}`, "node", 0, {
                approved: true,
            });
        }

        expect(deferredResolutionsSize()).toBeLessThanOrEqual(
            DEFERRED_RESOLUTIONS_MAX,
        );
    });
});
