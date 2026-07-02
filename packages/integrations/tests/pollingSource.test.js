import { describe, expect, test } from "bun:test";
import { Chunk, Effect, Schedule, Stream } from "effect";
import { createTestAdapter } from "./helpers.js";
import { makePollingSource } from "../src/core/EventSource.js";
import { makeDbCursorStore, makeInMemoryCursorStore } from "../src/core/CursorStore.js";

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
    test("polls on the schedule, advances the cursor, and emits events", async () => {
        const cursorStore = makeInMemoryCursorStore();
        /** @type {Array<string | null>} */
        const seenCursors = [];
        let tick = 0;
        const source = makePollingSource({
            id: "poll-test",
            cursorStore,
            schedule: Schedule.intersect(Schedule.spaced("10 millis"), Schedule.recurs(2)),
            // The injected poll callback is the user seam, not a mock of the
            // system under test: the Stream/cursor machinery is fully real.
            poll: (cursor) => Effect.sync(() => {
                seenCursors.push(cursor);
                tick += 1;
                return { events: [pollEvent(tick)], cursor: String(tick) };
            }),
        });
        const events = Chunk.toReadonlyArray(await Effect.runPromise(Stream.runCollect(Stream.take(source.events, 3))));
        expect(events.map((event) => event.payload.tick)).toEqual([1, 2, 3]);
        // First poll starts from the (absent) persisted cursor, then advances.
        expect(seenCursors).toEqual([null, "1", "2"]);
        expect(await Effect.runPromise(cursorStore.get("poll-test"))).toBe("3");
    });
    test("db cursor store persists across source restarts (same adapter/db)", async () => {
        const { adapter } = createTestAdapter();
        const cursorStore = makeDbCursorStore(adapter);
        /** @type {Array<string | null>} */
        const seenCursors = [];
        const makeSource = () => makePollingSource({
            id: "poll-db",
            cursorStore,
            schedule: Schedule.recurs(0),
            poll: (cursor) => Effect.sync(() => {
                seenCursors.push(cursor);
                const next = Number(cursor ?? "0") + 1;
                return { events: [pollEvent(next)], cursor: String(next) };
            }),
        });
        await Effect.runPromise(Stream.runCollect(Stream.take(makeSource().events, 1)));
        // A "restarted" source resumes from the persisted cursor, not from scratch.
        await Effect.runPromise(Stream.runCollect(Stream.take(makeSource().events, 1)));
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
