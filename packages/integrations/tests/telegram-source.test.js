import { afterAll, describe, expect, test } from "bun:test";
import { Chunk, Effect, Schedule, Stream } from "effect";
import { makeDbCursorStore } from "../src/core/CursorStore.js";
import {
  makeTelegramSource,
  TELEGRAM_CALLBACK_QUERY_EVENT,
  TELEGRAM_EDITED_MESSAGE_EVENT,
  TELEGRAM_MESSAGE_EVENT,
  TELEGRAM_WEB_APP_DATA_EVENT,
  telegramUpdateToEvents,
} from "../src/telegram/TelegramSource.js";
import { createTestAdapter } from "./helpers.js";
import { startTelegramFixture } from "./telegram-fixture.js";

/** @param {number} chatId @param {string} text */
function messageUpdate(chatId, text, extra = {}) {
  return {
    message: {
      message_id: Math.floor(Math.random() * 100000),
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private" },
      from: { id: 7, is_bot: false, first_name: "Will" },
      text,
      ...extra,
    },
  };
}

describe("telegramUpdateToEvents", () => {
  test("maps message updates with chat correlation and update dedupe key", () => {
    const events = telegramUpdateToEvents("telegram", { update_id: 10, ...messageUpdate(42, "hi") }, 123);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "telegram",
      eventName: TELEGRAM_MESSAGE_EVENT,
      correlationId: "chat:42",
      dedupeKey: "update:10",
      receivedAtMs: 123,
    });
    expect(/** @type {any} */ (events[0].payload).text).toBe("hi");
  });
  test("topical messages also emit a thread-correlation variant with a distinct dedupe key", () => {
    const events = telegramUpdateToEvents(
      "telegram",
      {
        update_id: 11,
        ...messageUpdate(42, "topic msg", { is_topic_message: true, message_thread_id: 9 }),
      },
      123,
    );
    expect(events).toHaveLength(2);
    expect(events.map((event) => [event.correlationId, event.dedupeKey])).toEqual([
      ["chat:42", "update:11"],
      ["chat:42:thread:9", "update:11:thread"],
    ]);
  });
  test("maps edited_message and callback_query updates", () => {
    const edited = telegramUpdateToEvents(
      "telegram",
      {
        update_id: 12,
        edited_message: messageUpdate(5, "fixed").message,
      },
      123,
    );
    expect(edited[0].eventName).toBe(TELEGRAM_EDITED_MESSAGE_EVENT);
    expect(edited[0].correlationId).toBe("chat:5");
    const callback = telegramUpdateToEvents(
      "telegram",
      {
        update_id: 13,
        callback_query: {
          id: "cb-13",
          from: { id: 7 },
          data: "approve",
          message: messageUpdate(5, "buttons").message,
        },
      },
      123,
    );
    expect(callback[0]).toMatchObject({
      eventName: TELEGRAM_CALLBACK_QUERY_EVENT,
      correlationId: "chat:5",
      dedupeKey: "update:13",
    });
    expect(/** @type {any} */ (callback[0].payload).data).toBe("approve");
  });
  test("a message carrying web_app_data also emits a web_app_data event", () => {
    const events = telegramUpdateToEvents(
      "telegram",
      {
        update_id: 14,
        message: {
          message_id: 88,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 42, type: "private" },
          web_app_data: { data: '{"decision":"approve"}', button_text: "Review" },
        },
      },
      123,
    );
    // Both the generic message event and the dedicated web_app_data event.
    expect(events.map((event) => event.eventName)).toEqual([TELEGRAM_MESSAGE_EVENT, TELEGRAM_WEB_APP_DATA_EVENT]);
    const webAppEvent = events.find((event) => event.eventName === TELEGRAM_WEB_APP_DATA_EVENT);
    expect(webAppEvent).toMatchObject({ correlationId: "chat:42", dedupeKey: "update:14:webappdata" });
    expect(/** @type {any} */ (webAppEvent?.payload).web_app_data.data).toBe('{"decision":"approve"}');
  });
});

describe("makeTelegramSource (long-poll against real fixture)", () => {
  // One fixture per test: getUpdates acks (and discards) updates only on
  // the NEXT poll, so shared fixture state would leak between tests.
  /** @type {Array<ReturnType<typeof startTelegramFixture>>} */
  const fixtures = [];
  afterAll(() => {
    for (const entry of fixtures) {
      entry.stop();
    }
  });
  const makeFixture = () => {
    const fixture = startTelegramFixture();
    fixtures.push(fixture);
    /** @param {Partial<import("../src/telegram/TelegramSource.ts").MakeTelegramSourceOptions>} [overrides] */
    const makeSource = (overrides = {}) =>
      makeTelegramSource({
        botToken: fixture.token,
        apiBaseUrl: fixture.apiBaseUrl,
        pollTimeoutSeconds: 1,
        schedule: Schedule.spaced("20 millis"),
        ...overrides,
      });
    return { fixture, makeSource };
  };
  test("delivers updates as ExternalEvents and advances offset = update_id + 1", async () => {
    const { fixture, makeSource } = makeFixture();
    const updateId = fixture.pushUpdate(messageUpdate(42, "hello"));
    const before = fixture.calls("getUpdates").length;
    const [batch] = Chunk.toReadonlyArray(
      await Effect.runPromise(Stream.runCollect(Stream.take(makeSource({ sourceId: "tg-a" }).events, 1))),
    );
    const events = batch.events;
    expect(events[0]).toMatchObject({
      eventName: TELEGRAM_MESSAGE_EVENT,
      correlationId: "chat:42",
      dedupeKey: `update:${updateId}`,
    });
    const polls = fixture.calls("getUpdates").slice(before);
    // First poll carries no offset (fresh cursor) plus long-poll params.
    expect(polls[0].body.offset).toBeUndefined();
    expect(polls[0].body.timeout).toBe(1);
    expect(polls[0].body.allowed_updates).toEqual(["message", "edited_message", "callback_query"]);
    await Effect.runPromise(batch.ack);
  });
  test("allowedChatIds gates non-allowed chats but still acknowledges them", async () => {
    const { fixture, makeSource } = makeFixture();
    fixture.pushUpdate(messageUpdate(666, "spam"));
    const okId = fixture.pushUpdate(messageUpdate(42, "legit"));
    const [batch] = Chunk.toReadonlyArray(
      await Effect.runPromise(
        Stream.runCollect(Stream.take(makeSource({ sourceId: "tg-gate", allowedChatIds: [42] }).events, 1)),
      ),
    );
    const events = batch.events;
    expect(events).toHaveLength(1);
    expect(events[0].correlationId).toBe("chat:42");
    expect(events[0].dedupeKey).toBe(`update:${okId}`);
    await Effect.runPromise(batch.ack);
  });
  test("cursor persists across a simulated restart: no re-delivery, offset resumes", async () => {
    const { fixture, makeSource } = makeFixture();
    const { adapter } = createTestAdapter();
    const cursorStore = makeDbCursorStore(adapter);
    const firstId = fixture.pushUpdate(messageUpdate(42, "before restart"));
    const [firstBatch] = Chunk.toReadonlyArray(
      await Effect.runPromise(
        Stream.runCollect(Stream.take(makeSource({ sourceId: "tg-restart", cursorStore }).events, 1)),
      ),
    );
    expect(firstBatch.events[0].dedupeKey).toBe(`update:${firstId}`);
    expect(await adapter.getIntegrationCursor("tg-restart")).toBeUndefined();
    await Effect.runPromise(firstBatch.ack);
    expect(await adapter.getIntegrationCursor("tg-restart")).toBe(String(firstId + 1));
    // "Restart": a brand-new source instance over the same db cursor store.
    const secondId = fixture.pushUpdate(messageUpdate(42, "after restart"));
    const beforePolls = fixture.calls("getUpdates").length;
    const [secondBatch] = Chunk.toReadonlyArray(
      await Effect.runPromise(
        Stream.runCollect(Stream.take(makeSource({ sourceId: "tg-restart", cursorStore }).events, 1)),
      ),
    );
    const run2 = secondBatch.events;
    const resumedPoll = fixture.calls("getUpdates").slice(beforePolls)[0];
    // Resumes from the persisted offset — Telegram discards the acked
    // update, so only the new one is delivered.
    expect(resumedPoll.body.offset).toBe(firstId + 1);
    expect(run2).toHaveLength(1);
    expect(run2[0].dedupeKey).toBe(`update:${secondId}`);
    expect(/** @type {any} */ (run2[0].payload).text).toBe("after restart");
    await Effect.runPromise(secondBatch.ack);
    expect(await adapter.getIntegrationCursor("tg-restart")).toBe(String(secondId + 1));
  });
});
