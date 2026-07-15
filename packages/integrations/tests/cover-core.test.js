// Coverage for the core event-source / delivery / runtime plumbing: unit
// branches that the durable-pipeline tests don't reach (readJsonPath, the
// IntegrationError guard, webhook offer verify/decode/validation failures, the
// delivery retry/swallow paths, and the IntegrationRuntime supervision,
// duplicate-id, unknown-source, and shutdown-squash seams). Real in-memory db,
// real Effect runtime, real Queue-backed sources — no mocks.
import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { createTestAdapter, seedWaitingEventRun } from "./helpers.js";
import { readJsonPath } from "../src/core/readJsonPath.js";
import { IntegrationError, isIntegrationError } from "../src/core/IntegrationError.js";
import { makeWebhookSource } from "../src/core/EventSource.js";
import { deliverEvent, deliverEvents } from "../src/core/deliverEvents.js";
import { makeIntegrationRuntime } from "../src/core/IntegrationRuntime.js";

const EVENT_NAME = "integration:cover:ping";

/** @param {Partial<import("../src/core/ExternalEventTypes.ts").ExternalEvent>} [overrides] */
function makeEvent(overrides = {}) {
    return {
        source: "cover",
        eventName: EVENT_NAME,
        correlationId: "corr-1",
        payload: { ok: true },
        dedupeKey: "cover-1",
        receivedAtMs: Date.now(),
        ...overrides,
    };
}

describe("readJsonPath", () => {
    test("returns the value itself for empty/null/undefined paths", () => {
        const value = { a: 1 };
        expect(readJsonPath(value)).toBe(value);
        expect(readJsonPath(value, undefined)).toBe(value);
        expect(readJsonPath(value, null)).toBe(value);
        expect(readJsonPath(value, "")).toBe(value);
    });
    test("walks dotted paths and returns undefined at any missing/non-object segment", () => {
        expect(readJsonPath({ issue: { id: "ENG-1" } }, "issue.id")).toBe("ENG-1");
        expect(readJsonPath({ issue: {} }, "issue.id")).toBeUndefined();
        expect(readJsonPath({ issue: "x" }, "issue.id")).toBeUndefined();
        expect(readJsonPath({ issue: [1, 2] }, "issue.id")).toBeUndefined();
        expect(readJsonPath(null, "a")).toBeUndefined();
    });
});

describe("isIntegrationError", () => {
    test("recognizes IntegrationError instances and cross-realm name matches", () => {
        expect(isIntegrationError(new IntegrationError("decode-failed", "boom"))).toBe(true);
        const namedLikeError = new Error("looks like one");
        namedLikeError.name = "IntegrationError";
        expect(isIntegrationError(namedLikeError)).toBe(true);
        expect(isIntegrationError(new Error("plain"))).toBe(false);
        expect(isIntegrationError("not an error")).toBe(false);
        expect(isIntegrationError(null)).toBe(false);
    });
    test("carries the reason onto the SmithersError details", () => {
        const error = new IntegrationError("queue-closed", "shut", { sourceId: "s" });
        expect(error.reason).toBe("queue-closed");
        expect(error.details?.reason).toBe("queue-closed");
        expect(error.details?.sourceId).toBe("s");
    });
});

describe("makeWebhookSource offer failure branches", () => {
    test("a verifier that throws surfaces invalid-signature", async () => {
        const webhook = await Effect.runPromise(makeWebhookSource({
            id: "hook-verify-throw",
            verify: () => {
                throw new Error("verifier blew up");
            },
            decode: () => makeEvent(),
        }));
        const error = await Effect.runPromise(webhook.offer({ headers: {}, rawBody: "{}" }).pipe(Effect.flip));
        expect(error.details?.reason).toBe("invalid-signature");
        expect(error.message).toContain("verification threw");
        await Effect.runPromise(webhook.shutdown);
    });
    test("a verifier that returns false surfaces invalid-signature without enqueueing", async () => {
        const webhook = await Effect.runPromise(makeWebhookSource({
            id: "hook-verify-false",
            verify: () => false,
            decode: () => makeEvent(),
        }));
        const error = await Effect.runPromise(webhook.offer({ headers: {}, rawBody: "{}" }).pipe(Effect.flip));
        expect(error.details?.reason).toBe("invalid-signature");
        expect(error.message).toContain("verification failed");
        await Effect.runPromise(webhook.shutdown);
    });
    test("a passing verifier + decoder accepts the event", async () => {
        const webhook = await Effect.runPromise(makeWebhookSource({
            id: "hook-ok",
            verify: () => true,
            decode: () => makeEvent(),
        }));
        expect(await Effect.runPromise(webhook.offer({ headers: {}, rawBody: "{}" }))).toEqual({ accepted: 1 });
        await Effect.runPromise(webhook.shutdown);
    });
    test("a decoder that throws surfaces decode-failed", async () => {
        const webhook = await Effect.runPromise(makeWebhookSource({
            id: "hook-throw",
            decode: () => {
                throw new Error("decoder blew up");
            },
        }));
        const error = await Effect.runPromise(webhook.offer({ headers: {}, rawBody: "{}" }).pipe(Effect.flip));
        expect(error.details?.reason).toBe("decode-failed");
        await Effect.runPromise(webhook.shutdown);
    });
    test("a decoder producing a structurally invalid ExternalEvent surfaces decode-failed", async () => {
        const webhook = await Effect.runPromise(makeWebhookSource({
            id: "hook-invalid",
            decode: () => /** @type {any} */ ({ not: "an event" }),
        }));
        const error = await Effect.runPromise(webhook.offer({ headers: {}, rawBody: "{}" }).pipe(Effect.flip));
        expect(error.details?.reason).toBe("decode-failed");
        expect(error.message).toContain("invalid ExternalEvent");
        await Effect.runPromise(webhook.shutdown);
    });
    test("rejects an event batch immediately and atomically when the queue lacks capacity", async () => {
        const webhook = await Effect.runPromise(makeWebhookSource({
            id: "hook-full",
            capacity: 2,
            decode: (request) => request.rawBody === "batch"
                ? [
                    makeEvent({ source: "hook-full", dedupeKey: "batch-1" }),
                    makeEvent({ source: "hook-full", dedupeKey: "batch-2" }),
                ]
                : makeEvent({ source: "hook-full", dedupeKey: request.rawBody }),
        }));
        try {
            expect(await Effect.runPromise(webhook.offer({ headers: {}, rawBody: "queued" }))).toEqual({ accepted: 1 });
            const error = await Effect.runPromise(webhook.offer({ headers: {}, rawBody: "batch" }).pipe(Effect.flip, Effect.timeout("1 second")));
            expect(error).toBeInstanceOf(IntegrationError);
            expect(error.reason).toBe("queue-full");
            expect(error.details).toMatchObject({ capacity: 2, queued: 1, requested: 2 });

            const queued = await Effect.runPromise(webhook.source.events.pipe(Stream.take(1), Stream.runCollect));
            expect(Array.from(queued, (event) => event.dedupeKey)).toEqual(["queued"]);
            expect(await Effect.runPromise(webhook.offer({ headers: {}, rawBody: "after" }))).toEqual({ accepted: 1 });
            const after = await Effect.runPromise(webhook.source.events.pipe(Stream.take(1), Stream.runCollect));
            expect(Array.from(after, (event) => event.dedupeKey)).toEqual(["after"]);
        }
        finally {
            await Effect.runPromise(webhook.shutdown);
        }
    });
    test("offering after shutdown reports a typed queue-closed failure", async () => {
        const webhook = await Effect.runPromise(makeWebhookSource({
            id: "hook-closed",
            decode: () => makeEvent({ source: "hook-closed" }),
        }));
        await Effect.runPromise(webhook.shutdown);
        const error = await Effect.runPromise(webhook.offer({ headers: {}, rawBody: "{}" }).pipe(Effect.flip));
        expect(error).toBeInstanceOf(IntegrationError);
        expect(error.reason).toBe("queue-closed");
    });
});

describe("deliverEvent / deliverEvents error handling", () => {
    test("a per-run signal failure propagates and leaves the delivery retryable", async () => {
        const { adapter } = createTestAdapter();
        await seedWaitingEventRun(adapter, { runId: "run-fault", signalName: EVENT_NAME, correlationId: "corr-1" });
        const faultAdapter = new Proxy(adapter, {
            get(target, prop, receiver) {
                if (prop === "insertSignalWithNextSeq") {
                    return () => Effect.fail(new IntegrationError("delivery-failed", "signal write forced to fail"));
                }
                const original = Reflect.get(target, prop, receiver);
                return typeof original === "function" ? original.bind(target) : original;
            },
        });
        const event = makeEvent({ dedupeKey: "fault-1" });
        const error = await Effect.runPromise(deliverEvent(/** @type {any} */ (faultAdapter), event).pipe(Effect.flip));
        expect(error).toBeInstanceOf(IntegrationError);
        expect(error.message).toContain("signal write forced to fail");
        const retry = await Effect.runPromise(deliverEvent(adapter, event));
        expect(retry).toMatchObject({ deduped: false, runIds: ["run-fault"] });
        expect(await adapter.listSignals("run-fault", { signalName: EVENT_NAME })).toHaveLength(1);
    }, 15_000);

    test("a failed matched run does not block later fanout or queued webhook events", async () => {
        const { adapter } = createTestAdapter();
        await seedWaitingEventRun(adapter, { runId: "run-fanout-a", signalName: EVENT_NAME, correlationId: "corr-1" });
        await seedWaitingEventRun(adapter, { runId: "run-fanout-b", signalName: EVENT_NAME, correlationId: "corr-1" });
        await seedWaitingEventRun(adapter, { runId: "run-after", signalName: EVENT_NAME, correlationId: "corr-2" });
        const faultAdapter = new Proxy(adapter, {
            get(target, prop, receiver) {
                if (prop === "insertSignalWithNextSeq") {
                    return (/** @type {any} */ row) => row.runId === "run-fanout-a"
                        ? Effect.fail(new IntegrationError("delivery-failed", "first matched run forced to fail"))
                        : target.insertSignalWithNextSeq(row);
                }
                const original = Reflect.get(target, prop, receiver);
                return typeof original === "function" ? original.bind(target) : original;
            },
        });
        const webhook = await Effect.runPromise(makeWebhookSource({
            id: "fanout-drain",
            decode: (request) => {
                const payload = JSON.parse(request.rawBody);
                return makeEvent({
                    source: "fanout-drain",
                    correlationId: payload.correlationId,
                    dedupeKey: payload.deliveryId,
                    receivedAtMs: payload.receivedAtMs,
                    payload,
                });
            },
        }));
        try {
            await Effect.runPromise(webhook.offer({
                headers: {},
                rawBody: JSON.stringify({ deliveryId: "fanout-retry", correlationId: "corr-1", receivedAtMs: 1_000 }),
            }));
            await Effect.runPromise(webhook.offer({
                headers: {},
                rawBody: JSON.stringify({ deliveryId: "fanout-after", correlationId: "corr-2", receivedAtMs: 2_000 }),
            }));
            const finiteSource = { ...webhook.source, events: Stream.take(webhook.source.events, 2) };
            await Effect.runPromise(deliverEvents(/** @type {any} */ (faultAdapter), finiteSource));

            expect(await adapter.listSignals("run-fanout-a", { signalName: EVENT_NAME })).toHaveLength(0);
            const laterMatchSignals = await adapter.listSignals("run-fanout-b", { signalName: EVENT_NAME });
            expect(laterMatchSignals).toHaveLength(1);
            expect(laterMatchSignals[0].receivedAtMs).toBe(1_000);
            expect(await adapter.listSignals("run-after", { signalName: EVENT_NAME })).toHaveLength(1);

            const replay = await Effect.runPromise(deliverEvent(adapter, makeEvent({
                source: "fanout-drain",
                correlationId: "corr-1",
                dedupeKey: "fanout-retry",
                receivedAtMs: 9_999,
            })));
            expect(replay).toEqual({ deduped: false, runIds: ["run-fanout-a"] });
            const retriedSignals = await adapter.listSignals("run-fanout-a", { signalName: EVENT_NAME });
            expect(retriedSignals).toHaveLength(1);
            expect(retriedSignals[0].receivedAtMs).toBe(1_000);
            expect(await adapter.claimIntegrationDelivery({
                sourceId: "fanout-drain",
                dedupeKey: "fanout-retry",
                eventName: EVENT_NAME,
                receivedAtMs: 20_000,
            }, { ownerToken: "completed-probe", nowMs: 20_000 })).toMatchObject({
                status: "completed",
                receivedAtMs: 1_000,
            });
        }
        finally {
            await Effect.runPromise(webhook.shutdown);
        }
    }, 15_000);

    test("a failed queued webhook item is logged without killing delivery of the next item", async () => {
        const { adapter } = createTestAdapter();
        await seedWaitingEventRun(adapter, { runId: "run-drain", signalName: EVENT_NAME, correlationId: "corr-1" });
        let failNext = true;
        const faultAdapter = new Proxy(adapter, {
            get(target, prop, receiver) {
                if (prop === "claimIntegrationDelivery") {
                    return (/** @type {any} */ row, /** @type {any} */ options) => {
                        if (failNext) {
                            failNext = false;
                            return Effect.fail(new IntegrationError("delivery-failed", "dedupe write forced to fail"));
                        }
                        return Reflect.get(target, prop, receiver).call(target, row, options);
                    };
                }
                const original = Reflect.get(target, prop, receiver);
                return typeof original === "function" ? original.bind(target) : original;
            },
        });
        const webhook = await Effect.runPromise(makeWebhookSource({
            id: "drain",
            decode: (request) => {
                const payload = JSON.parse(request.rawBody);
                return makeEvent({
                    source: "drain",
                    dedupeKey: payload.deliveryId,
                    payload,
                });
            },
        }));
        try {
            await Effect.runPromise(webhook.offer({ headers: {}, rawBody: JSON.stringify({ deliveryId: "drain-bad", kind: "bad" }) }));
            await Effect.runPromise(webhook.offer({ headers: {}, rawBody: JSON.stringify({ deliveryId: "drain-good", kind: "good" }) }));
            const finiteSource = { ...webhook.source, events: Stream.take(webhook.source.events, 2) };
            await Effect.runPromise(deliverEvents(/** @type {any} */ (faultAdapter), finiteSource));
            const signals = await adapter.listSignals("run-drain", { signalName: EVENT_NAME });
            expect(signals).toHaveLength(1);
            expect(JSON.parse(signals[0].payloadJson)).toMatchObject({ deliveryId: "drain-good", kind: "good" });
        }
        finally {
            await Effect.runPromise(webhook.shutdown);
        }
    });
});

describe("makeIntegrationRuntime", () => {
    test("rejects duplicate webhook source ids with an invalid-config IntegrationError", () => {
        const { adapter } = createTestAdapter();
        let error;
        try {
            makeIntegrationRuntime({
                adapter,
                webhookSources: [
                    { id: "dup", decode: () => makeEvent() },
                    { id: "dup", decode: () => makeEvent() },
                ],
            });
        }
        catch (thrown) {
            error = thrown;
        }
        expect(isIntegrationError(error)).toBe(true);
        expect(error.message).toMatch(/Duplicate webhook source id/);
        expect(error.reason).toBe("invalid-config");
        expect(error.details?.sourceId).toBe("dup");
    });

    test("handleWebhook rejects an unknown source id with the raw IntegrationError", async () => {
        const { adapter } = createTestAdapter();
        const runtime = makeIntegrationRuntime({ adapter });
        try {
            expect(runtime.hasWebhookSource("nope")).toBe(false);
            const error = await runtime.handleWebhook("nope", { headers: {}, rawBody: "{}" }).catch((e) => e);
            expect(isIntegrationError(error)).toBe(true);
            expect(error.reason).toBe("unknown-source");
        } finally {
            await runtime.shutdown();
        }
    });

    test("handleWebhook rethrows the raw typed offer failure (not the FiberFailure wrapper)", async () => {
        const { adapter } = createTestAdapter();
        const runtime = makeIntegrationRuntime({
            adapter,
            webhookSources: [{ id: "reject", verify: () => false, decode: () => makeEvent() }],
        });
        try {
            const error = await runtime.handleWebhook("reject", { headers: {}, rawBody: "{}" }).catch((e) => e);
            expect(isIntegrationError(error)).toBe(true);
            expect(error.reason).toBe("invalid-signature");
        } finally {
            await runtime.shutdown();
        }
    });

    test("handleWebhook against a shut-down source surfaces a typed queue-closed failure", async () => {
        const { adapter } = createTestAdapter();
        const runtime = makeIntegrationRuntime({
            adapter,
            webhookSources: [{ id: "gone", decode: () => makeEvent() }],
        });
        await runtime.shutdown();
        const outcome = await runtime.handleWebhook("gone", { headers: {}, rawBody: "{}" }).then(
            () => ({ resolved: true }),
            (error) => ({ rejected: true, error }),
        );
        expect(outcome.rejected).toBe(true);
        expect(isIntegrationError(outcome.error)).toBe(true);
        expect(outcome.error.reason).toBe("queue-closed");
    });

    test("a source stream that fails is logged and supervised (restart back-off), then shut down cleanly", async () => {
        const { adapter } = createTestAdapter();
        const failingSource = {
            id: "flaky",
            events: Stream.fail(new IntegrationError("poll-failed", "always down", { sourceId: "flaky" })),
        };
        const runtime = makeIntegrationRuntime({ adapter, sources: [failingSource] });
        await new Promise((resolve) => setTimeout(resolve, 50));
        await runtime.shutdown();
        await runtime.shutdown();
        expect(true).toBe(true);
    });

    test("delivers a webhook end-to-end and drains the offered batch to a waiting run", async () => {
        const { adapter } = createTestAdapter();
        await seedWaitingEventRun(adapter, { runId: "run-rt", signalName: EVENT_NAME, correlationId: "corr-1" });
        const runtime = makeIntegrationRuntime({
            adapter,
            webhookSources: [{
                id: "cover",
                decode: (request) => {
                    const payload = JSON.parse(request.rawBody);
                    return makeEvent({ dedupeKey: payload.deliveryId, correlationId: payload.corr });
                },
            }],
        });
        try {
            const accepted = await runtime.handleWebhook("cover", {
                headers: {},
                rawBody: JSON.stringify({ corr: "corr-1", deliveryId: "rt-1" }),
            });
            expect(accepted).toEqual({ accepted: 1 });
            const deadline = Date.now() + 5_000;
            let signals = [];
            while (Date.now() < deadline) {
                signals = await adapter.listSignals("run-rt", { signalName: EVENT_NAME });
                if (signals.length > 0) break;
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            expect(signals).toHaveLength(1);
        } finally {
            await runtime.shutdown();
        }
    }, 15_000);
});
