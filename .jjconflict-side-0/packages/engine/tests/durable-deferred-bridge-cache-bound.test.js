import { describe, expect, test } from "bun:test";
import {
    DEFERRED_RESOLUTIONS_MAX,
    awaitApprovalDurableDeferred,
    bridgeApprovalResolve,
    deferredResolutionsSize,
} from "../src/effect/durable-deferred-bridge.js";

describe("deferredResolutions is bounded", () => {
    test("evicts old unresolved resolutions while retaining recent ones", async () => {
        const adapter = {};
        const total = DEFERRED_RESOLUTIONS_MAX + 50;

        for (let i = 0; i < total; i += 1) {
            await bridgeApprovalResolve(adapter, `run-${i}`, "approval", 0, {
                approved: true,
            });
        }

        expect(deferredResolutionsSize()).toBe(DEFERRED_RESOLUTIONS_MAX);
        await expect(
            awaitApprovalDurableDeferred(adapter, "run-0", "approval", 0),
        ).resolves.toEqual({ _tag: "Pending" });
        await expect(
            awaitApprovalDurableDeferred(adapter, `run-${total - 1}`, "approval", 0),
        ).resolves.toMatchObject({ _tag: "Complete" });
    });
});
