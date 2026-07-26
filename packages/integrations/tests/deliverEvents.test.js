import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Effect, Fiber, Schedule } from "effect";
import { createTestAdapter, seedWaitingEventRun } from "./helpers.js";
import { deliverEvent, deliverEvents } from "../src/core/deliverEvents.js";
import { makePollingSource, makeWebhookSource } from "../src/core/EventSource.js";
import { makeDbCursorStore } from "../src/core/CursorStore.js";
import { IntegrationError } from "../src/core/IntegrationError.js";
import { verifySignature } from "../src/core/verifySignature.js";
import { signalRun } from "@smithers-orchestrator/engine/signals";

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
  test("replays only unfinished runs after a crash during fanout", async () => {
    const { adapter } = createTestAdapter();
    await seedWaitingEventRun(adapter, { runId: "run-fanout-a", signalName: EVENT_NAME, correlationId: "corr-1" });
    await seedWaitingEventRun(adapter, { runId: "run-fanout-b", signalName: EVENT_NAME, correlationId: "corr-1" });
    const event = makeEvent({ dedupeKey: "fanout-crash", receivedAtMs: 1_000 });
    expect(
      (
        await adapter.claimIntegrationDelivery(
          {
            sourceId: event.source,
            dedupeKey: event.dedupeKey,
            eventName: event.eventName,
            receivedAtMs: event.receivedAtMs,
          },
          { ownerToken: "crashed-worker", nowMs: 2_000 },
        )
      ).status,
    ).toBe("claimed");
    await Effect.runPromise(
      signalRun(adapter, "run-fanout-a", event.eventName, event.payload, {
        correlationId: event.correlationId ?? undefined,
        receivedBy: `integration:${event.source}`,
        timestampMs: event.receivedAtMs,
      }),
    );
    expect(await adapter.releaseIntegrationDeliveryClaim(event.source, event.dedupeKey, "crashed-worker")).toBe(true);

    const replay = await Effect.runPromise(deliverEvent(adapter, { ...event, receivedAtMs: 9_999 }));
    expect(replay).toEqual({ deduped: false, runIds: ["run-fanout-b"] });
    expect(await adapter.listSignals("run-fanout-a", { signalName: EVENT_NAME })).toHaveLength(1);
    const secondSignals = await adapter.listSignals("run-fanout-b", { signalName: EVENT_NAME });
    expect(secondSignals).toHaveLength(1);
    expect(secondSignals[0].receivedAtMs).toBe(1_000);
    expect((await Effect.runPromise(deliverEvent(adapter, event))).deduped).toBe(true);
  });
  test("replay closes the signal-insert/bridge window without a duplicate row", async () => {
    const { adapter } = createTestAdapter();
    await seedWaitingEventRun(adapter, { runId: "run-window", signalName: EVENT_NAME, correlationId: "corr-1" });
    const event = makeEvent({ dedupeKey: "bridge-window", receivedAtMs: 1_234 });
    expect(
      (
        await adapter.claimIntegrationDelivery(
          {
            sourceId: event.source,
            dedupeKey: event.dedupeKey,
            eventName: event.eventName,
            receivedAtMs: event.receivedAtMs,
          },
          { ownerToken: "crashed-worker", nowMs: 2_000 },
        )
      ).status,
    ).toBe("claimed");
    expect(
      await adapter.insertSignalWithNextSeq({
        runId: "run-window",
        signalName: event.eventName,
        correlationId: event.correlationId,
        payloadJson: JSON.stringify(event.payload),
        receivedAtMs: event.receivedAtMs,
        receivedBy: `integration:${event.source}`,
      }),
    ).toBe(0);
    expect(await adapter.releaseIntegrationDeliveryClaim(event.source, event.dedupeKey, "crashed-worker")).toBe(true);

    const replay = await Effect.runPromise(deliverEvent(adapter, { ...event, receivedAtMs: 9_999 }));
    expect(replay).toEqual({ deduped: false, runIds: ["run-window"] });
    const signals = await adapter.listSignals("run-window", { signalName: EVENT_NAME });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ seq: 0, receivedAtMs: 1_234, receivedBy: "integration:test" });
    expect(await adapter.findRunsAwaitingEvent(EVENT_NAME, "corr-1")).toEqual([]);
  });
});

describe("poll batch delivery durability", () => {
  const pollingEvent = (dedupeKey, correlationId) => makeEvent({ dedupeKey, correlationId, receivedAtMs: 1_000 });

  test("a typed run failure reaches later matches but leaves the polling cursor unacked", async () => {
    const { adapter } = createTestAdapter();
    const cursorStore = makeDbCursorStore(adapter);
    await seedWaitingEventRun(adapter, { runId: "run-poll-a", signalName: EVENT_NAME, correlationId: "poll-fanout" });
    await seedWaitingEventRun(adapter, { runId: "run-poll-b", signalName: EVENT_NAME, correlationId: "poll-fanout" });
    const faultAdapter = new Proxy(adapter, {
      get(target, prop, receiver) {
        if (prop === "insertSignalWithNextSeq") {
          return (/** @type {any} */ row) =>
            row.runId === "run-poll-a"
              ? Effect.fail(new IntegrationError("delivery-failed", "first polling match forced to fail"))
              : target.insertSignalWithNextSeq(row);
        }
        const original = Reflect.get(target, prop, receiver);
        return typeof original === "function" ? original.bind(target) : original;
      },
    });
    let pollCount = 0;
    const makeSource = () =>
      makePollingSource({
        id: "poll-fanout",
        cursorStore,
        schedule: Schedule.recurs(0),
        poll: () =>
          Effect.sync(() => {
            pollCount += 1;
            return {
              events: [
                makeEvent({
                  dedupeKey: "poll-fanout-event",
                  correlationId: "poll-fanout",
                  receivedAtMs: pollCount === 1 ? 1_000 : 9_999,
                }),
              ],
              cursor: "1",
            };
          }),
      });

    const error = await Effect.runPromise(
      deliverEvents(/** @type {any} */ (faultAdapter), makeSource()).pipe(Effect.flip),
    );
    expect(error.message).toContain("first polling match forced to fail");
    expect(await adapter.getIntegrationCursor("poll-fanout")).toBeUndefined();
    expect(await adapter.listSignals("run-poll-a", { signalName: EVENT_NAME })).toHaveLength(0);
    const laterMatchSignals = await adapter.listSignals("run-poll-b", { signalName: EVENT_NAME });
    expect(laterMatchSignals).toHaveLength(1);
    expect(laterMatchSignals[0].receivedAtMs).toBe(1_000);

    const retry = await adapter.claimIntegrationDelivery(
      {
        sourceId: "test",
        dedupeKey: "poll-fanout-event",
        eventName: EVENT_NAME,
        receivedAtMs: 20_000,
      },
      { ownerToken: "retry-probe", nowMs: Date.now() },
    );
    expect(retry).toMatchObject({ status: "claimed", receivedAtMs: 1_000 });
    expect(await adapter.releaseIntegrationDeliveryClaim("test", "poll-fanout-event", "retry-probe")).toBe(true);

    await Effect.runPromise(deliverEvents(adapter, makeSource()));
    expect(await adapter.getIntegrationCursor("poll-fanout")).toBe("1");
    const retriedSignals = await adapter.listSignals("run-poll-a", { signalName: EVENT_NAME });
    expect(retriedSignals).toHaveLength(1);
    expect(retriedSignals[0].receivedAtMs).toBe(1_000);
    expect(await adapter.listSignals("run-poll-b", { signalName: EVENT_NAME })).toHaveLength(1);
  }, 15_000);

  test("a busy second event fails the batch; restart dedupes the first and then acks", async () => {
    const { adapter } = createTestAdapter();
    const cursorStore = makeDbCursorStore(adapter);
    const events = [pollingEvent("batch-1", "batch-1"), pollingEvent("batch-2", "batch-2")];
    expect(
      (
        await adapter.claimIntegrationDelivery(
          {
            sourceId: events[1].source,
            dedupeKey: events[1].dedupeKey,
            eventName: events[1].eventName,
            receivedAtMs: events[1].receivedAtMs,
          },
          { ownerToken: "competing-worker", nowMs: Date.now(), leaseDurationMs: 30_000 },
        )
      ).status,
    ).toBe("claimed");
    /** @type {Array<string | null>} */
    const seenCursors = [];
    const makeSource = () =>
      makePollingSource({
        id: "batch-restart",
        cursorStore,
        schedule: Schedule.recurs(0),
        poll: (cursor) =>
          Effect.sync(() => {
            seenCursors.push(cursor);
            return { events, cursor: "2" };
          }),
      });

    const error = await Effect.runPromise(deliverEvents(adapter, makeSource()).pipe(Effect.flip));
    expect(error.message).toContain("already claimed");
    expect(await adapter.getIntegrationCursor("batch-restart")).toBeUndefined();
    expect(
      (
        await adapter.claimIntegrationDelivery(
          {
            sourceId: events[0].source,
            dedupeKey: events[0].dedupeKey,
            eventName: events[0].eventName,
            receivedAtMs: 9_999,
          },
          { ownerToken: "probe", nowMs: Date.now() },
        )
      ).status,
    ).toBe("completed");
    expect(
      await adapter.releaseIntegrationDeliveryClaim(events[1].source, events[1].dedupeKey, "competing-worker"),
    ).toBe(true);

    await Effect.runPromise(deliverEvents(adapter, makeSource()));
    expect(seenCursors).toEqual([null, null]);
    expect(await adapter.getIntegrationCursor("batch-restart")).toBe("2");
    expect(
      (
        await adapter.claimIntegrationDelivery(
          {
            sourceId: events[1].source,
            dedupeKey: events[1].dedupeKey,
            eventName: events[1].eventName,
            receivedAtMs: 9_999,
          },
          { ownerToken: "probe", nowMs: Date.now() },
        )
      ).status,
    ).toBe("completed");
  });

  test("interrupting mid-batch releases the in-flight claim and leaves the cursor unacked", async () => {
    const { adapter } = createTestAdapter();
    const cursorStore = makeDbCursorStore(adapter);
    const events = [pollingEvent("interrupt-1", "interrupt-1"), pollingEvent("interrupt-2", "interrupt-2")];
    /** @type {() => void} */
    let enteredSecond;
    const entered = new Promise((resolve) => {
      enteredSecond = resolve;
    });
    const gatedAdapter = new Proxy(adapter, {
      get(target, prop, receiver) {
        if (prop === "findRunsAwaitingEvent") {
          return (eventName, correlationId) =>
            correlationId === "interrupt-2"
              ? Effect.sync(() => enteredSecond()).pipe(Effect.zipRight(Effect.never))
              : target.findRunsAwaitingEvent(eventName, correlationId);
        }
        const original = Reflect.get(target, prop, receiver);
        return typeof original === "function" ? original.bind(target) : original;
      },
    });
    const makeSource = () =>
      makePollingSource({
        id: "batch-interrupt",
        cursorStore,
        schedule: Schedule.recurs(0),
        poll: () => Effect.succeed({ events, cursor: "2" }),
      });
    const drain = Effect.runFork(deliverEvents(/** @type {any} */ (gatedAdapter), makeSource()));
    await Promise.race([
      entered,
      new Promise((_, reject) => setTimeout(() => reject(new Error("second event was not reached")), 5_000)),
    ]);
    await Effect.runPromise(Fiber.interrupt(drain));
    expect(await adapter.getIntegrationCursor("batch-interrupt")).toBeUndefined();

    await Effect.runPromise(deliverEvents(adapter, makeSource()));
    expect(await adapter.getIntegrationCursor("batch-interrupt")).toBe("2");
    expect(
      (
        await adapter.claimIntegrationDelivery(
          {
            sourceId: events[1].source,
            dedupeKey: events[1].dedupeKey,
            eventName: events[1].eventName,
            receivedAtMs: 9_999,
          },
          { ownerToken: "probe", nowMs: Date.now() },
        )
      ).status,
    ).toBe("completed");
  });

  test("interrupting the first event leaves no progress and makes its claim immediately reclaimable", async () => {
    const { adapter } = createTestAdapter();
    const cursorStore = makeDbCursorStore(adapter);
    const event = pollingEvent("interrupt-first", "interrupt-first");
    /** @type {() => void} */
    let enteredDelivery;
    const entered = new Promise((resolve) => {
      enteredDelivery = resolve;
    });
    const gatedAdapter = new Proxy(adapter, {
      get(target, prop, receiver) {
        if (prop === "findRunsAwaitingEvent") {
          return () => Effect.sync(() => enteredDelivery()).pipe(Effect.zipRight(Effect.never));
        }
        const original = Reflect.get(target, prop, receiver);
        return typeof original === "function" ? original.bind(target) : original;
      },
    });
    const makeSource = () =>
      makePollingSource({
        id: "batch-interrupt-first",
        cursorStore,
        schedule: Schedule.recurs(0),
        poll: () => Effect.succeed({ events: [event], cursor: "1" }),
      });
    const drain = Effect.runFork(deliverEvents(/** @type {any} */ (gatedAdapter), makeSource()));
    await Promise.race([
      entered,
      new Promise((_, reject) => setTimeout(() => reject(new Error("first event was not reached")), 5_000)),
    ]);
    await Effect.runPromise(Fiber.interrupt(drain));
    expect(await adapter.getIntegrationCursor("batch-interrupt-first")).toBeUndefined();

    expect(
      await adapter.claimIntegrationDelivery(
        {
          sourceId: event.source,
          dedupeKey: event.dedupeKey,
          eventName: event.eventName,
          receivedAtMs: 9_999,
        },
        { ownerToken: "immediate-retry", nowMs: Date.now() },
      ),
    ).toMatchObject({
      status: "claimed",
      receivedAtMs: 1_000,
    });
    expect(await adapter.releaseIntegrationDeliveryClaim(event.source, event.dedupeKey, "immediate-retry")).toBe(true);
    await Effect.runPromise(deliverEvents(adapter, makeSource()));
    expect(await adapter.getIntegrationCursor("batch-interrupt-first")).toBe("1");
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
    const webhook = await Effect.runPromise(
      makeWebhookSource({
        id: "test",
        verify: (request) =>
          verifySignature({
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
      }),
    );
    const drain = Effect.runFork(deliverEvents(adapter, webhook.source));
    const rawBody = JSON.stringify({ corr: "corr-1", deliveryId: "d-1", hello: "world" });
    const headers = {
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
    };
    // Bad signature fails with invalid-signature and enqueues nothing.
    const rejected = await Effect.runPromise(
      webhook.offer({ headers: { "x-hub-signature-256": "sha256=deadbeef" }, rawBody }).pipe(Effect.flip),
    );
    expect(rejected.details?.reason).toBe("invalid-signature");
    // Good signature is accepted; redelivery of the same delivery id dedupes.
    expect(await Effect.runPromise(webhook.offer({ headers, rawBody }))).toEqual({ accepted: 1 });
    expect(await Effect.runPromise(webhook.offer({ headers, rawBody }))).toEqual({ accepted: 1 });
    const deadline = Date.now() + 5_000;
    let signals = [];
    while (Date.now() < deadline) {
      signals = await adapter.listSignals("run-hook", { signalName: EVENT_NAME });
      if (signals.length > 0) break;
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
