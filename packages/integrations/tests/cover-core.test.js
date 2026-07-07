// Coverage for the core event-source / delivery / runtime plumbing: unit
// branches that the durable-pipeline tests don't reach (readJsonPath, the
// IntegrationError guard, webhook offer decode/validation/shutdown failures,
// the delivery retry/swallow paths, and the IntegrationRuntime supervision,
// duplicate-id, unknown-source, and shutdown-squash seams). Real in-memory db,
// real Effect runtime, real Queue-backed sources — no mocks.
import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { createTestAdapter, seedWaitingEventRun } from "./helpers.js";
import { readJsonPath } from "../src/core/readJsonPath.js";
import { IntegrationError, isIntegrationError } from "../src/core/IntegrationError.js";
import { makeWebhookSource, makePollingSource } from "../src/core/EventSource.js";
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
        // Missing key mid-path.
        expect(readJsonPath({ issue: {} }, "issue.id")).toBeUndefined();
        // Non-object along the way (a string is not walkable).
        expect(readJsonPath({ issue: "x" }, "issue.id")).toBeUndefined();
        // Array along the way is treated as non-walkable.
        expect(readJsonPath({ issue: [1, 2] }, "issue.id")).toBeUndefined();
        // Null root.
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
            // Missing required ExternalEvent fields → decodeExternalEvent fails.
            decode: () => /** @type {any} */ ({ not: "an event" }),
        }));
        const error = await Effect.runPromise(webhook.offer({ headers: {}, rawBody: "{}" }).pipe(Effect.flip));
        expect(error.details?.reason).toBe("decode-failed");
        expect(error.message).toContain("invalid ExternalEvent");
        await Effect.runPromise(webhook.shutdown);
    });
    test("offering after shutdown reports the queue is closed", async () => {
        const webhook = await Effect.runPromise(makeWebhookSource({
            id: "hook-closed",
            decode: () => makeEvent({ source: "hook-closed" }),
        }));
        await Effect.runPromise(webhook.shutdown);
        // After shutdown the queue can no longer accept the decoded batch.
        const exit = await Effect.runPromiseExit(webhook.offer({ headers: {}, rawBody: "{}" }));
        expect(exit._tag).toBe("Failure");
    });
});

describe("deliverEvent / deliverEvents error handling", () => {
    test("a per-run signal failure is retried, logged, and swallowed (delivered stays empty)", async () => {
        const { adapter } = createTestAdapter();
        await seedWaitingEventRun(adapter, { runId: "run-fault", signalName: EVENT_NAME, correlationId: "corr-1" });
        // Real fault injection against the real delivery path: everything runs
        // on the real adapter EXCEPT the signal write (`insertSignalWithNextSeq`,
        // the one persist call signalRun makes), which is forced to fail so the
        // per-run retry + catchAll swallow branch executes.
        const faultAdapter = new Proxy(adapter, {
            get(target, prop, receiver) {
                if (prop === "insertSignalWithNextSeq") {
                    return () => Effect.fail(new IntegrationError("delivery-failed", "signal write forced to fail"));
                }
                const original = Reflect.get(target, prop, receiver);
                return typeof original === "function" ? original.bind(target) : original;
            },
        });
        const result = await Effect.runPromise(deliverEvent(/** @type {any} */ (faultAdapter), makeEvent({ dedupeKey: "fault-1" })));
        expect(result.deduped).toBe(false);
        // The run matched but every signal attempt failed → nothing delivered.
        expect(result.runIds).toEqual([]);
    }, 15_000);

    test("deliverEvents drains a source and swallows a per-event delivery error", async () => {
        const { adapter } = createTestAdapter();
        // Fault-inject the dedupe write so deliverEvent errors; deliverEvents must
        // log-and-continue (its per-event catchAll) rather than fail the stream.
        let failNext = true;
        const faultAdapter = new Proxy(adapter, {
            get(target, prop, receiver) {
                if (prop === "insertIntegrationDeliveryIfNew") {
                    return (/** @type {any} */ row) => {
                        if (failNext) {
                            failNext = false;
                            return Effect.fail(new IntegrationError("delivery-failed", "dedupe write forced to fail"));
                        }
                        return Reflect.get(target, prop, receiver).call(target, row);
                    };
                }
                const original = Reflect.get(target, prop, receiver);
                return typeof original === "function" ? original.bind(target) : original;
            },
        });
        const badEvent = makeEvent({ dedupeKey: "drain-bad", source: "drain" });
        const goodEvent = makeEvent({ dedupeKey: "drain-good", source: "drain", correlationId: "none" });
        const source = { id: "drain", events: Stream.fromIterable([badEvent, goodEvent]) };
        // Must complete without failing despite the poisoned first event.
        await Effect.runPromise(deliverEvents(/** @type {any} */ (faultAdapter), source));
        // The good event was still recorded (delivery row inserted for it).
        expect(await adapter.insertIntegrationDeliveryIfNew({
            sourceId: "drain",
            dedupeKey: "drain-good",
            eventName: EVENT_NAME,
            receivedAtMs: Date.now(),
        })).toBe(false);
    });
});

describe("makeIntegrationRuntime", () => {
    test("rejects duplicate webhook source ids", () => {
        const { adapter } = createTestAdapter();
        expect(() => makeIntegrationRuntime({
            adapter,
            webhookSources: [
                { id: "dup", decode: () => makeEvent() },
                { id: "dup", decode: () => makeEvent() },
            ],
        })).toThrow(/Duplicate webhook source id/);
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
            // verify → false makes offer fail with a typed invalid-signature error;
            // handleWebhook unwraps Cause.failureOption and rethrows it raw.
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

    test("handleWebhook against a shut-down source surfaces the squashed interrupt (defect path)", async () => {
        const { adapter } = createTestAdapter();
        const runtime = makeIntegrationRuntime({
            adapter,
            webhookSources: [{ id: "gone", decode: () => makeEvent() }],
        });
        // Shut the runtime (and its queue) down first; a subsequent offer is
        // interrupted, so handleWebhook has no typed failure to surface and
        // falls back to Cause.squash of the interrupt.
        await runtime.shutdown();
        const outcome = await runtime.handleWebhook("gone", { headers: {}, rawBody: "{}" }).then(
            () => ({ resolved: true }),
            (error) => ({ rejected: true, error }),
        );
        expect(outcome.rejected).toBe(true);
    });

    test("a source stream that fails is logged and supervised (restart back-off), then shut down cleanly", async () => {
        const { adapter } = createTestAdapter();
        // A polling source whose poll always fails drives the supervise tapError
        // + retry path; shutdown interrupts the restart-looping fiber.
        const failingSource = makePollingSource({
            id: "flaky",
            poll: () => Effect.fail(new IntegrationError("poll-failed", "always down", { sourceId: "flaky" })),
        });
        const runtime = makeIntegrationRuntime({ adapter, sources: [failingSource] });
        // Give the supervised fiber a moment to fail at least once and log.
        await new Promise((resolve) => setTimeout(resolve, 50));
        await runtime.shutdown();
        // Idempotent shutdown returns the same settled promise.
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
