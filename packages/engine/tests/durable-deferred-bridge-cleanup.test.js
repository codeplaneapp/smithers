import { describe, expect, test } from "bun:test";
import { Exit } from "effect";
import {
    awaitApprovalDurableDeferred,
    awaitWaitForEventDurableDeferred,
    bridgeApprovalResolve,
    bridgeWaitForEventResolve,
} from "../src/effect/durable-deferred-bridge.js";

// Each fresh object is a distinct adapter namespace, so distinct execution ids.
function makeMemoryAdapter() {
    return { db: { $client: { filename: ":memory:" } } };
}

const signal = {
    signalName: "deploy.ready",
    correlationId: null,
    payloadJson: "{\"ok\":true}",
    seq: 1,
    receivedAtMs: 1234,
};

// Wait-for-event resolution touches the DB before resolving the deferred, so a
// minimal adapter is needed when exercising bridgeWaitForEventResolve.
function makeWaitForEventAdapter() {
    return {
        db: { $client: { filename: ":memory:" } },
        listAttempts: () => Exit.succeed([]),
    };
}

describe("durable deferred bridge cleanup", () => {
    test("await evicts the consumed approval resolution so a second await is Pending", async () => {
        const adapter = makeMemoryAdapter();

        await bridgeApprovalResolve(adapter, "run", "node", 0, { approved: true });

        const first = await awaitApprovalDurableDeferred(adapter, "run", "node", 0);
        expect(first._tag).toBe("Complete");

        // Pre-fix this returned "Complete" again because the entry was never
        // deleted, leaking the executionId in the module-level Map forever.
        const second = await awaitApprovalDurableDeferred(adapter, "run", "node", 0);
        expect(second._tag).toBe("Pending");
    });

    test("await evicts the consumed wait-for-event resolution", async () => {
        const adapter = makeWaitForEventAdapter();

        await bridgeWaitForEventResolve(adapter, "run", "wait", 0, signal);

        const first = await awaitWaitForEventDurableDeferred(adapter, "run", "wait", 0);
        expect(first._tag).toBe("Complete");

        const second = await awaitWaitForEventDurableDeferred(adapter, "run", "wait", 0);
        expect(second._tag).toBe("Pending");
    });

    test("await of an unresolved execution id is Pending and does not leak", async () => {
        const adapter = makeMemoryAdapter();

        const result = await awaitApprovalDurableDeferred(adapter, "run", "never-resolved", 0);
        expect(result._tag).toBe("Pending");

        const again = await awaitApprovalDurableDeferred(adapter, "run", "never-resolved", 0);
        expect(again._tag).toBe("Pending");
    });
});
