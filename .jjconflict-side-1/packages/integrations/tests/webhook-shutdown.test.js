import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option, Stream } from "effect";
import { createTestAdapter, seedWaitingEventRun } from "./helpers.js";
import { makePollingSource, makeWebhookSource } from "../src/core/EventSource.js";
import { IntegrationError } from "../src/core/IntegrationError.js";
import { makeIntegrationRuntime } from "../src/core/IntegrationRuntime.js";

const EVENT_NAME = "integration:shutdown:ping";

function deferred() {
    /** @type {(value?: unknown) => void} */
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function decodeEvent(request, source = "shutdown-hook") {
    const payload = JSON.parse(request.rawBody);
    return {
        source,
        eventName: EVENT_NAME,
        correlationId: payload.correlationId ?? null,
        payload,
        dedupeKey: payload.deliveryId,
        receivedAtMs: payload.receivedAtMs ?? Date.now(),
    };
}

describe("webhook source graceful close", () => {
    test("full advertised capacity drains FIFO before one idempotent EOS", async () => {
        const webhook = await Effect.runPromise(makeWebhookSource({
            id: "full-close",
            capacity: 2,
            decode: (request) => decodeEvent(request, "full-close"),
        }));
        expect(await Effect.runPromise(webhook.offer({ headers: {}, rawBody: JSON.stringify({ deliveryId: "first" }) }))).toEqual({ accepted: 1 });
        expect(await Effect.runPromise(webhook.offer({ headers: {}, rawBody: JSON.stringify({ deliveryId: "second" }) }))).toEqual({ accepted: 1 });
        const full = await Effect.runPromise(webhook.offer({ headers: {}, rawBody: JSON.stringify({ deliveryId: "overflow" }) }).pipe(Effect.flip));
        expect(full).toBeInstanceOf(IntegrationError);
        expect(full.reason).toBe("queue-full");

        await Effect.runPromise(Effect.all([webhook.shutdown, webhook.shutdown], {
            concurrency: "unbounded",
            discard: true,
        }).pipe(Effect.timeout("1 second")));
        const closed = await Effect.runPromise(webhook.offer({ headers: {}, rawBody: JSON.stringify({ deliveryId: "late" }) }).pipe(Effect.flip));
        expect(closed).toBeInstanceOf(IntegrationError);
        expect(closed.reason).toBe("queue-closed");

        const drained = Array.from(await Effect.runPromise(Stream.runCollect(webhook.source.events)));
        expect(drained.map((event) => event.dedupeKey)).toEqual(["first", "second"]);
    });

    test("racing batch offers are either fully accepted before close or queue-closed", async () => {
        const webhook = await Effect.runPromise(makeWebhookSource({
            id: "offer-close-race",
            capacity: 4,
            decode: (request) => {
                const prefix = request.rawBody;
                return [
                    decodeEvent({ ...request, rawBody: JSON.stringify({ deliveryId: `${prefix}-1` }) }, "offer-close-race"),
                    decodeEvent({ ...request, rawBody: JSON.stringify({ deliveryId: `${prefix}-2` }) }, "offer-close-race"),
                ];
            },
        }));
        const settleOffer = (request) => Effect.runPromiseExit(webhook.offer(request));
        const [first, second] = await Promise.all([
            settleOffer({ headers: {}, rawBody: "a" }),
            settleOffer({ headers: {}, rawBody: "b" }),
            Effect.runPromise(webhook.shutdown),
        ]);
        for (const exit of [first, second]) {
            if (Exit.isSuccess(exit)) {
                expect(exit.value).toEqual({ accepted: 2 });
            }
            else {
                const failure = Cause.failureOption(exit.cause);
                expect(Option.isSome(failure)).toBe(true);
                if (Option.isSome(failure)) {
                    expect(failure.value).toBeInstanceOf(IntegrationError);
                    expect(failure.value.reason).toBe("queue-closed");
                }
            }
        }
        const acceptedPrefixes = [first, second]
            .flatMap((exit, index) => Exit.isSuccess(exit) ? [index === 0 ? "a" : "b"] : []);
        const drained = Array.from(await Effect.runPromise(Stream.runCollect(webhook.source.events)));
        expect(drained).toHaveLength(acceptedPrefixes.length * 2);
        expect(drained.map((event) => event.dedupeKey).sort()).toEqual(acceptedPrefixes.flatMap((prefix) => [`${prefix}-1`, `${prefix}-2`]).sort());
    });
});

describe("integration runtime graceful shutdown", () => {
    test("shutdown propagates a webhook delivery fiber defect", async () => {
        const { adapter } = createTestAdapter();
        const defectEntered = deferred();
        const defectiveAdapter = new Proxy(adapter, {
            get(target, prop, receiver) {
                if (prop === "findRunsAwaitingEvent") {
                    return () => Effect.sync(() => defectEntered.resolve()).pipe(
                        Effect.zipRight(Effect.die(new Error("forced webhook delivery defect"))),
                    );
                }
                const original = Reflect.get(target, prop, receiver);
                return typeof original === "function" ? original.bind(target) : original;
            },
        });
        const runtime = makeIntegrationRuntime({
            adapter: /** @type {any} */ (defectiveAdapter),
            webhookSources: [{
                id: "defect-hook",
                decode: (request) => decodeEvent(request, "defect-hook"),
            }],
        });

        await runtime.handleWebhook("defect-hook", {
            headers: {},
            rawBody: JSON.stringify({ deliveryId: "defective-delivery" }),
        });
        await defectEntered.promise;

        const shutdown = runtime.shutdown();
        expect(runtime.shutdown()).toBe(shutdown);
        await expect(shutdown).rejects.toThrow("forced webhook delivery defect");
        await runtime.shutdown().catch(() => undefined);
    });

    test("accepted pulled and queued webhooks finish before polling and custom fibers stop", async () => {
        const { adapter } = createTestAdapter();
        await seedWaitingEventRun(adapter, { runId: "shutdown-run-1", signalName: EVENT_NAME, correlationId: "corr-1" });
        await seedWaitingEventRun(adapter, { runId: "shutdown-run-2", signalName: EVENT_NAME, correlationId: "corr-2" });

        const deliveryEntered = deferred();
        const releaseDelivery = deferred();
        const gatedAdapter = new Proxy(adapter, {
            get(target, prop, receiver) {
                if (prop === "findRunsAwaitingEvent") {
                    return (eventName, correlationId) => correlationId === "corr-1"
                        ? Effect.sync(() => deliveryEntered.resolve()).pipe(
                            Effect.zipRight(Effect.promise(() => releaseDelivery.promise)),
                            Effect.zipRight(target.findRunsAwaitingEvent(eventName, correlationId)),
                        )
                        : target.findRunsAwaitingEvent(eventName, correlationId);
                }
                const original = Reflect.get(target, prop, receiver);
                return typeof original === "function" ? original.bind(target) : original;
            },
        });

        const pollingStarted = deferred();
        let pollingFinalized = 0;
        const polling = makePollingSource({
            id: "shutdown-polling",
            poll: () => Effect.sync(() => pollingStarted.resolve()).pipe(
                Effect.zipRight(Effect.never),
                Effect.ensuring(Effect.sync(() => {
                    pollingFinalized += 1;
                })),
            ),
        });
        const customStarted = deferred();
        let customFinalized = 0;
        const custom = {
            id: "shutdown-custom",
            events: Stream.fromEffect(Effect.sync(() => customStarted.resolve()).pipe(
                Effect.zipRight(Effect.never),
                Effect.ensuring(Effect.sync(() => {
                    customFinalized += 1;
                })),
            )),
        };
        const runtime = makeIntegrationRuntime({
            adapter: /** @type {any} */ (gatedAdapter),
            sources: [polling, custom],
            webhookSources: [{
                id: "shutdown-hook",
                capacity: 2,
                decode: (request) => decodeEvent(request),
            }],
        });
        let shutdown;
        try {
            await Promise.all([pollingStarted.promise, customStarted.promise]);
            expect(await runtime.handleWebhook("shutdown-hook", {
                headers: {},
                rawBody: JSON.stringify({ deliveryId: "delivery-1", correlationId: "corr-1", receivedAtMs: 1_000 }),
            })).toEqual({ accepted: 1 });
            await deliveryEntered.promise;
            expect(await runtime.handleWebhook("shutdown-hook", {
                headers: {},
                rawBody: JSON.stringify({ deliveryId: "delivery-2", correlationId: "corr-2", receivedAtMs: 2_000 }),
            })).toEqual({ accepted: 1 });

            shutdown = runtime.shutdown();
            expect(runtime.shutdown()).toBe(shutdown);
            let shutdownResolved = false;
            shutdown.then(() => {
                shutdownResolved = true;
            });
            await new Promise((resolve) => setTimeout(resolve, 25));
            expect(shutdownResolved).toBe(false);
            expect(pollingFinalized).toBe(0);
            expect(customFinalized).toBe(0);
            const rejected = await runtime.handleWebhook("shutdown-hook", { headers: {}, rawBody: "{}" }).catch((error) => error);
            expect(rejected).toBeInstanceOf(IntegrationError);
            expect(rejected.reason).toBe("queue-closed");

            releaseDelivery.resolve();
            await shutdown;
            expect(pollingFinalized).toBe(1);
            expect(customFinalized).toBe(1);
            for (const [runId, deliveryId, receivedAtMs] of [
                ["shutdown-run-1", "delivery-1", 1_000],
                ["shutdown-run-2", "delivery-2", 2_000],
            ]) {
                const signals = await adapter.listSignals(runId, { signalName: EVENT_NAME });
                expect(signals).toHaveLength(1);
                expect(JSON.parse(signals[0].payloadJson).deliveryId).toBe(deliveryId);
                expect(signals[0].receivedAtMs).toBe(receivedAtMs);
                expect(await adapter.claimIntegrationDelivery({
                    sourceId: "shutdown-hook",
                    dedupeKey: deliveryId,
                    eventName: EVENT_NAME,
                    receivedAtMs: 99_999,
                }, { ownerToken: `probe-${deliveryId}`, nowMs: 100_000 })).toMatchObject({
                    status: "completed",
                    receivedAtMs,
                });
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
            expect(pollingFinalized).toBe(1);
            expect(customFinalized).toBe(1);
        }
        finally {
            releaseDelivery.resolve();
            await runtime.shutdown();
        }
    }, 15_000);
});
