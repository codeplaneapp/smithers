import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Effect, Fiber } from "effect";
import { createTestAdapter, seedWaitingEventRun } from "./helpers.js";
import { deliverEvent, deliverEvents } from "../src/core/deliverEvents.js";
import { makeWebhookSource } from "../src/core/EventSource.js";
import { verifySignature } from "../src/core/verifySignature.js";

const EVENT_NAME = "integration:test:ping";

/**
 * @param {Partial<import("../src/core/ExternalEvent.ts").ExternalEvent>} [overrides]
 * @returns {import("../src/core/ExternalEvent.ts").ExternalEvent}
 */
function makeEvent(overrides = {}) {
    return {
        source: "test",
        eventName: EVENT_NAME,
        correlationId: "corr-1",
        payload: { ok: true },
        dedupeKey: "delivery-1",
        receivedAtMs: Date.now(),
        ...overrides,
    };
}

describe("deliverEvent", () => {
    test("signals a run parked on WaitForEvent and records the signal row", async () => {
        const { adapter } = createTestAdapter();
        await seedWaitingEventRun(adapter, {
            runId: "run-1",
            signalName: EVENT_NAME,
            correlationId: "corr-1",
        });
        const result = await Effect.runPromise(deliverEvent(adapter, makeEvent()));
        expect(result.deduped).toBe(false);
        expect(result.runIds).toEqual(["run-1"]);
        const signals = await adapter.listSignals("run-1", { signalName: EVENT_NAME });
        expect(signals).toHaveLength(1);
        expect(JSON.parse(signals[0].payloadJson)).toEqual({ ok: true });
        expect(signals[0].receivedBy).toBe("integration:test");
        expect(signals[0].correlationId).toBe("corr-1");
    });
    test("dedupes redeliveries by (source, dedupeKey)", async () => {
        const { adapter } = createTestAdapter();
        await seedWaitingEventRun(adapter, {
            runId: "run-1",
            signalName: EVENT_NAME,
            correlationId: "corr-1",
        });
        const first = await Effect.runPromise(deliverEvent(adapter, makeEvent()));
        const second = await Effect.runPromise(deliverEvent(adapter, makeEvent()));
        expect(first.deduped).toBe(false);
        expect(second.deduped).toBe(true);
        expect(second.runIds).toEqual([]);
        const signals = await adapter.listSignals("run-1", { signalName: EVENT_NAME });
        expect(signals).toHaveLength(1);
    });
    test("does not match runs waiting on a different event or correlationId", async () => {
        const { adapter } = createTestAdapter();
        await seedWaitingEventRun(adapter, {
            runId: "run-other-event",
            signalName: "integration:test:pong",
            correlationId: "corr-1",
        });
        await seedWaitingEventRun(adapter, {
            runId: "run-other-corr",
            signalName: EVENT_NAME,
            correlationId: "corr-2",
        });
        const result = await Effect.runPromise(deliverEvent(adapter, makeEvent()));
        expect(result.runIds).toEqual([]);
    });
    test("skips terminal runs even when a waiting-event node row lingers", async () => {
        const { adapter } = createTestAdapter();
        await seedWaitingEventRun(adapter, {
            runId: "run-done",
            signalName: EVENT_NAME,
            correlationId: "corr-1",
            runStatus: "finished",
        });
        const result = await Effect.runPromise(deliverEvent(adapter, makeEvent()));
        expect(result.runIds).toEqual([]);
    });
});

describe("findRunsAwaitingEvent", () => {
    test("matches on event name + normalized correlationId across runs", async () => {
        const { adapter } = createTestAdapter();
        await seedWaitingEventRun(adapter, {
            runId: "run-a",
            signalName: EVENT_NAME,
            correlationId: "corr-1",
        });
        await seedWaitingEventRun(adapter, {
            runId: "run-b",
            signalName: EVENT_NAME,
            correlationId: "corr-1",
        });
        await seedWaitingEventRun(adapter, {
            runId: "run-null-corr",
            signalName: EVENT_NAME,
            correlationId: null,
        });
        const matched = await adapter.findRunsAwaitingEvent(EVENT_NAME, "corr-1");
        expect([...matched].sort()).toEqual(["run-a", "run-b"]);
        // Blank correlation ids normalize to null and match null-correlation waits.
        expect(await adapter.findRunsAwaitingEvent(EVENT_NAME, "   ")).toEqual(["run-null-corr"]);
        expect(await adapter.findRunsAwaitingEvent(EVENT_NAME, null)).toEqual(["run-null-corr"]);
    });
});

describe("webhook source → deliverEvents pipeline", () => {
    test("offer verifies, enqueues, and the drained stream signals waiting runs", async () => {
        const { adapter } = createTestAdapter();
        await seedWaitingEventRun(adapter, {
            runId: "run-hook",
            signalName: EVENT_NAME,
            correlationId: "corr-1",
        });
        const secret = "hook-secret";
        const webhook = await Effect.runPromise(makeWebhookSource({
            id: "test",
            verify: (request) => verifySignature({
                payload: request.rawBody,
                secret,
                signature: Array.isArray(request.headers["x-hub-signature-256"])
                    ? request.headers["x-hub-signature-256"][0]
                    : request.headers["x-hub-signature-256"],
                prefix: "sha256=",
            }),
            decode: (request) => {
                const payload = JSON.parse(request.rawBody);
                return {
                    source: "test",
                    eventName: EVENT_NAME,
                    correlationId: payload.corr ?? null,
                    payload,
                    dedupeKey: payload.deliveryId,
                    receivedAtMs: Date.now(),
                };
            },
        }));
        const drain = Effect.runFork(deliverEvents(adapter, webhook.source));
        const rawBody = JSON.stringify({ corr: "corr-1", deliveryId: "d-1", hello: "world" });
        const headers = {
            "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
        };
        // Bad signature fails with invalid-signature and enqueues nothing.
        const rejected = await Effect.runPromise(webhook.offer({ headers: { "x-hub-signature-256": "sha256=deadbeef" }, rawBody }).pipe(Effect.flip));
        expect(rejected.details?.reason).toBe("invalid-signature");
        // Good signature is accepted; redelivery of the same delivery id dedupes.
        expect(await Effect.runPromise(webhook.offer({ headers, rawBody }))).toEqual({ accepted: 1 });
        expect(await Effect.runPromise(webhook.offer({ headers, rawBody }))).toEqual({ accepted: 1 });
        const deadline = Date.now() + 5_000;
        let signals = [];
        while (Date.now() < deadline) {
            signals = await adapter.listSignals("run-hook", { signalName: EVENT_NAME });
            if (signals.length > 0)
                break;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(signals).toHaveLength(1);
        expect(JSON.parse(signals[0].payloadJson)).toMatchObject({ hello: "world" });
        // Give the second (deduped) delivery a beat, then confirm no extra signal.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(await adapter.listSignals("run-hook", { signalName: EVENT_NAME })).toHaveLength(1);
        await Effect.runPromise(webhook.shutdown);
        await Effect.runPromise(Fiber.interrupt(drain));
    });
});
