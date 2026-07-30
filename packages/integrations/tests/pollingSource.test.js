import { describe, expect, test } from "bun:test";
import { Chunk, Effect, Schedule, Stream } from "effect";
import { createTestAdapter } from "./helpers.js";
import { makePollingSource } from "../src/core/EventSource.js";
import { makeDbCursorStore, makeInMemoryCursorStore } from "../src/core/CursorStore.js";
import { IntegrationError } from "../src/core/IntegrationError.js";

/**
 * @param {number} tick
 * @returns {import("../src/core/ExternalEvent.ts").ExternalEvent}
 */
function pollEvent(tick) {
  return {
    source: "poll-test",
    eventName: "integration:poll-test:update",
    correlationId: null,
    payload: { tick },
    dedupeKey: `update-${tick}`,
    receivedAtMs: Date.now(),
  };
}

describe("makePollingSource", () => {
  test("polls on the schedule and advances each cursor only after its batch ack", async () => {
    const cursorStore = makeInMemoryCursorStore();
    /** @type {Array<string | null>} */
    const seenCursors = [];
    /** @type {number[]} */
    const emittedTicks = [];
    let tick = 0;
    const source = makePollingSource({
      id: "poll-test",
      cursorStore,
      schedule: Schedule.spaced("10 millis").pipe(Schedule.upTo({ times: 2 })),
      // The injected poll callback is the user seam, not a mock of the
      // system under test: the Stream/cursor machinery is fully real.
      poll: (cursor) =>
        Effect.sync(() => {
          seenCursors.push(cursor);
          tick += 1;
          return { events: [pollEvent(tick)], cursor: String(tick) };
        }),
    });
    await Effect.runPromise(
      Stream.runForEach(Stream.take(source.events, 3), (batch) =>
        Effect.gen(function* () {
          expect(batch._tag).toBe("EventBatch");
          emittedTicks.push(batch.events[0].payload.tick);
          yield* batch.ack;
        }),
      ),
    );
    expect(emittedTicks).toEqual([1, 2, 3]);
    // First poll starts from the (absent) persisted cursor, then advances.
    expect(seenCursors).toEqual([null, "1", "2"]);
    expect(await Effect.runPromise(cursorStore.get("poll-test"))).toBe("3");
  });
  test("an unacknowledged batch is re-polled from the committed cursor", async () => {
    const cursorStore = makeInMemoryCursorStore();
    /** @type {Array<string | null>} */
    const seenCursors = [];
    const source = makePollingSource({
      id: "poll-unacked",
      cursorStore,
      schedule: Schedule.spaced("10 millis").pipe(Schedule.upTo({ times: 1 })),
      poll: (cursor) =>
        Effect.sync(() => {
          seenCursors.push(cursor);
          const next = Number(cursor ?? "0") + 1;
          return { events: [pollEvent(next)], cursor: String(next) };
        }),
    });
    const batches = Chunk.toReadonlyArray(await Effect.runPromise(Stream.runCollect(Stream.take(source.events, 2))));
    expect(seenCursors).toEqual([null, null]);
    expect(batches.map((batch) => batch.events[0].dedupeKey)).toEqual(["update-1", "update-1"]);
    expect(await Effect.runPromise(cursorStore.get("poll-unacked"))).toBeUndefined();
    await Effect.runPromise(batches[0].ack);
    expect(await Effect.runPromise(cursorStore.get("poll-unacked"))).toBe("1");
  });
  test("empty batches can acknowledge cursor progress", async () => {
    const cursorStore = makeInMemoryCursorStore();
    const source = makePollingSource({
      id: "poll-empty",
      cursorStore,
      schedule: Schedule.recurs(0),
      poll: () => Effect.succeed({ events: [], cursor: "after-empty" }),
    });
    const [batch] = Chunk.toReadonlyArray(await Effect.runPromise(Stream.runCollect(Stream.take(source.events, 1))));
    expect(batch.events).toEqual([]);
    expect(await Effect.runPromise(cursorStore.get("poll-empty"))).toBeUndefined();
    await Effect.runPromise(batch.ack);
    expect(await Effect.runPromise(cursorStore.get("poll-empty"))).toBe("after-empty");
  });
  test("a failed durable cursor write leaves the next source on the old cursor", async () => {
    /** @type {string | null | undefined} */
    let persisted;
    let failNextSet = true;
    const cursorStore = {
      get: () => Effect.sync(() => persisted),
      set: (_sourceId, cursor) =>
        failNextSet
          ? Effect.sync(() => {
              failNextSet = false;
            }).pipe(
              Effect.flatMap(() => Effect.fail(new IntegrationError("delivery-failed", "forced cursor write failure"))),
            )
          : Effect.sync(() => {
              persisted = cursor;
            }),
    };
    /** @type {Array<string | null>} */
    const seenCursors = [];
    const makeSource = () =>
      makePollingSource({
        id: "poll-store-fault",
        cursorStore,
        schedule: Schedule.recurs(0),
        poll: (cursor) =>
          Effect.sync(() => {
            seenCursors.push(cursor);
            return { events: [pollEvent(1)], cursor: "1" };
          }),
      });
    const [failedBatch] = Chunk.toReadonlyArray(
      await Effect.runPromise(Stream.runCollect(Stream.take(makeSource().events, 1))),
    );
    const failure = await Effect.runPromise(failedBatch.ack.pipe(Effect.flip));
    expect(failure).toBeInstanceOf(IntegrationError);
    expect(persisted).toBeUndefined();
    const [retryBatch] = Chunk.toReadonlyArray(
      await Effect.runPromise(Stream.runCollect(Stream.take(makeSource().events, 1))),
    );
    expect(seenCursors).toEqual([null, null]);
    await Effect.runPromise(retryBatch.ack);
    expect(persisted).toBe("1");
  });
  test("db cursor store persists across source restarts (same adapter/db)", async () => {
    const { adapter } = createTestAdapter();
    const cursorStore = makeDbCursorStore(adapter);
    /** @type {Array<string | null>} */
    const seenCursors = [];
    const makeSource = () =>
      makePollingSource({
        id: "poll-db",
        cursorStore,
        schedule: Schedule.recurs(0),
        poll: (cursor) =>
          Effect.sync(() => {
            seenCursors.push(cursor);
            const next = Number(cursor ?? "0") + 1;
            return { events: [pollEvent(next)], cursor: String(next) };
          }),
      });
    const [first] = Chunk.toReadonlyArray(
      await Effect.runPromise(Stream.runCollect(Stream.take(makeSource().events, 1))),
    );
    await Effect.runPromise(first.ack);
    // A "restarted" source resumes from the persisted cursor, not from scratch.
    const [second] = Chunk.toReadonlyArray(
      await Effect.runPromise(Stream.runCollect(Stream.take(makeSource().events, 1))),
    );
    await Effect.runPromise(second.ack);
    expect(seenCursors).toEqual([null, "1"]);
    expect(await adapter.getIntegrationCursor("poll-db")).toBe("2");
  });
});

describe("integration cursor adapter methods", () => {
  test("get/set round-trip including null cursors and upsert overwrite", async () => {
    const { adapter } = createTestAdapter();
    expect(await adapter.getIntegrationCursor("missing")).toBeUndefined();
    await adapter.setIntegrationCursor("src", "42");
    expect(await adapter.getIntegrationCursor("src")).toBe("42");
    await adapter.setIntegrationCursor("src", "43");
    expect(await adapter.getIntegrationCursor("src")).toBe("43");
    await adapter.setIntegrationCursor("src", null);
    expect(await adapter.getIntegrationCursor("src")).toBeNull();
  });
  test("insertIntegrationDeliveryIfNew reports first-vs-redelivery", async () => {
    const { adapter } = createTestAdapter();
    const row = {
      sourceId: "src",
      dedupeKey: "d-1",
      eventName: "integration:src:e",
      receivedAtMs: Date.now(),
    };
    expect(await adapter.insertIntegrationDeliveryIfNew(row)).toBe(true);
    expect(await adapter.insertIntegrationDeliveryIfNew(row)).toBe(false);
    expect(await adapter.insertIntegrationDeliveryIfNew({ ...row, dedupeKey: "d-2" })).toBe(true);
    expect(await adapter.insertIntegrationDeliveryIfNew({ ...row, sourceId: "other" })).toBe(true);
  });
});
