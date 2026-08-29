import { Effect, Layer, Schedule, Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { CursorStore, layerMemory } from "../src/core/CursorStore.ts"
import type { ExternalEvent } from "../src/core/ExternalEvent.ts"
import * as Payload from "../src/telegram/Payload.ts"
import {
  CALLBACK_QUERY_EVENT,
  chatCorrelationId,
  EDITED_MESSAGE_EVENT,
  make,
  MESSAGE_EVENT,
  threadCorrelationId,
  updateToEvents,
  WEB_APP_DATA_EVENT
} from "../src/telegram/Source.ts"
import { make as makeClient } from "../src/telegram/TelegramClient.ts"
import { type Fixture, json, startFixture } from "./Fixture.ts"

const TOKEN = "123456:AA-bot-token"
const NOW = 1_700_000_000_000

let fixture: Fixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

const message = (overrides: Record<string, unknown> = {}) => ({
  message_id: 1,
  date: 1,
  chat: { id: -100 },
  text: "hello",
  ...overrides
})

describe("updateToEvents", () => {
  it("emits a chat-scoped message event", () => {
    expect(updateToEvents("telegram", { update_id: 7, message: message() }, NOW)).toEqual([{
      source: "telegram",
      eventName: MESSAGE_EVENT,
      correlationId: chatCorrelationId(-100),
      payload: message(),
      dedupeKey: "update:7",
      receivedAtMs: NOW
    }])
  })

  // One delivered event carries one correlation, and each variant dedupes on
  // its own key, so a redelivery cannot double-signal either listener.
  it("adds a thread-scoped variant with its own dedupe key", () => {
    const events = updateToEvents("telegram", {
      update_id: 7,
      message: message({ message_thread_id: 5 })
    }, NOW)
    expect(events.map((event) => [event.correlationId, event.dedupeKey])).toEqual([
      [chatCorrelationId(-100), "update:7"],
      [threadCorrelationId(-100, 5), "update:7:thread"]
    ])
  })

  it("emits a separately deduped Mini App data event alongside the message", () => {
    const events = updateToEvents("telegram", {
      update_id: 7,
      message: message({ web_app_data: { data: "{}" }, message_thread_id: 5 })
    }, NOW)
    expect(events.map((event) => [event.eventName, event.dedupeKey])).toEqual([
      [MESSAGE_EVENT, "update:7"],
      [MESSAGE_EVENT, "update:7:thread"],
      [WEB_APP_DATA_EVENT, "update:7:webappdata"],
      [WEB_APP_DATA_EVENT, "update:7:webappdata:thread"]
    ])
  })

  it("names an edited message differently", () => {
    const events = updateToEvents("telegram", { update_id: 8, edited_message: message() }, NOW)
    expect(events.map((event) => event.eventName)).toEqual([EDITED_MESSAGE_EVENT])
  })

  it("carries a callback query's chat and thread when it has them", () => {
    const query = { id: "q", data: "sap:t:a", message: { chat: { id: -100 }, message_thread_id: 5 } }
    const events = updateToEvents("telegram", { update_id: 9, callback_query: query }, NOW)
    expect(events.map((event) => [event.eventName, event.correlationId, event.dedupeKey])).toEqual([
      [CALLBACK_QUERY_EVENT, chatCorrelationId(-100), "update:9"],
      [CALLBACK_QUERY_EVENT, threadCorrelationId(-100, 5), "update:9:thread"]
    ])
  })

  it("emits an uncorrelated callback query when the message is inaccessible", () => {
    const events = updateToEvents("telegram", { update_id: 9, callback_query: { id: "q" } }, NOW)
    expect(events[0]?.correlationId).toBeNull()
  })

  it("drops a message with no chat, and an update of a kind it does not handle", () => {
    expect(updateToEvents("telegram", { update_id: 1, message: { message_id: 1 } }, NOW)).toEqual([])
    expect(updateToEvents("telegram", { update_id: 1, poll: {} }, NOW)).toEqual([])
  })
})

const source = (options: Parameters<typeof make>[0] = {}) =>
  make({
    client: makeClient({ botToken: TOKEN, apiBaseUrl: (fixture as Fixture).origin }),
    ...options
  })

const runWithCursors = <A, E>(effect: Effect.Effect<A, E, CursorStore>, layer = layerMemory) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>)

describe("poll", () => {
  it("sends the Bot API long-poll parameters and the stored offset", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true, result: [] }))
    await Effect.runPromise(source().poll("41"))
    expect(JSON.parse(fixture.requests[0]?.body ?? "{}")).toEqual({
      timeout: 25,
      allowed_updates: ["message", "edited_message", "callback_query"],
      offset: 41
    })
  })

  it("omits the offset for a source that has never polled", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true, result: [] }))
    await Effect.runPromise(source().poll(null))
    expect(JSON.parse(fixture.requests[0]?.body ?? "{}")).not.toHaveProperty("offset")
  })

  it("proposes the acknowledgement offset as last update_id plus one", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, {
        ok: true,
        result: [{ update_id: 10, message: message() }, { update_id: 12, message: message() }]
      })
    )
    const batch = await Effect.runPromise(source().poll(null))
    expect(batch.events).toHaveLength(2)
    expect(batch.cursor).toBe("13")
  })

  it("proposes no cursor when the poll returned nothing usable", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true, result: [{ no_id: true }] }))
    expect(await Effect.runPromise(source().poll(null))).toEqual({ events: [] })
  })

  it("tolerates a result that is not an array", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true, result: true }))
    expect(await Effect.runPromise(source().poll(null))).toEqual({ events: [] })
  })

  // The offset still advances past a dropped update, or the source would
  // re-poll it forever.
  it("drops updates from chats outside the allow list but still advances past them", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, {
        ok: true,
        result: [
          { update_id: 1, message: message({ chat: { id: -999 } }) },
          { update_id: 2, message: message() }
        ]
      })
    )
    const batch = await Effect.runPromise(source({ allowedChatIds: [-100] }).poll(null))
    expect(batch.events).toHaveLength(1)
    expect(batch.cursor).toBe("3")
  })

  it("takes an explicit source id, timeout, and allowed updates", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, { ok: true, result: [{ update_id: 1, message: message() }] })
    )
    const batch = await Effect.runPromise(
      source({ sourceId: "telegram-ops", pollTimeoutSeconds: 5, allowedUpdates: ["message"] }).poll(null)
    )
    expect(batch.events[0]?.source).toBe("telegram-ops")
    expect(JSON.parse(fixture.requests[0]?.body ?? "{}")).toMatchObject({ timeout: 5, allowed_updates: ["message"] })
  })

  it("classifies a Bot API failure as poll-failed and names the source", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 401, { ok: false, error_code: 401, description: "Unauthorized" })
    )
    const failure = await Effect.runPromise(Effect.flip(source().poll(null)))
    expect(failure.reason).toBe("poll-failed")
    expect(failure.details).toMatchObject({ sourceId: "telegram" })
  })

  it("builds its own client from a bot token when given no client", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true, result: [] }))
    await Effect.runPromise(make({ botToken: TOKEN, apiBaseUrl: fixture.origin }).poll(null))
    expect(fixture.requests[0]?.url).toBe(`/bot${TOKEN}/getUpdates`)
  })
})

describe("run", () => {
  it("commits the offset only after the handler succeeded", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, { ok: true, result: [{ update_id: 10, message: message() }] })
    )
    const handled: Array<ReadonlyArray<ExternalEvent>> = []
    const cursor = await runWithCursors(Effect.gen(function*() {
      const store = yield* CursorStore
      yield* Effect.timeout(
        source().run((events) => Effect.sync(() => handled.push(events)), { schedule: Schedule.spaced("5 millis") }),
        "120 millis"
      ).pipe(Effect.catchCause(() => Effect.void))
      return yield* store.get("telegram")
    }))
    expect(handled.length).toBeGreaterThan(0)
    expect(cursor).toBe("11")
  })

  // If a failed handler still advanced the offset, Telegram would forget the
  // batch and the events would be lost.
  it("leaves the offset alone when the handler fails", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, { ok: true, result: [{ update_id: 10, message: message() }] })
    )
    const cursor = await runWithCursors(Effect.gen(function*() {
      const store = yield* CursorStore
      yield* source().run(() => Effect.fail("handler failed" as const)).pipe(Effect.catchCause(() => Effect.void))
      return yield* store.get("telegram")
    }))
    expect(cursor).toBeNull()
  })

  it("resumes from the stored offset", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true, result: [] }))
    await runWithCursors(Effect.gen(function*() {
      const store = yield* CursorStore
      yield* store.set("telegram", "500")
      yield* Effect.timeout(
        source().run(() => Effect.void, { schedule: Schedule.spaced("5 millis") }),
        "60 millis"
      ).pipe(Effect.catchCause(() => Effect.void))
    }))
    expect(JSON.parse(fixture.requests[0]?.body ?? "{}").offset).toBe(500)
  })

  it("stops when the fiber is interrupted", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true, result: [] }))
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.timeout(source().run(() => Effect.void, { schedule: Schedule.spaced("5 millis") }), "60 millis")
          .pipe(Effect.provide(layerMemory as Layer.Layer<CursorStore>))
      )
    )
    expect(exit._tag).toBe("Failure")
    // Let any poll that was already in flight settle, then prove the loop is
    // not still turning.
    await Effect.runPromise(Effect.sleep("100 millis"))
    const settled = fixture.requests.length
    await Effect.runPromise(Effect.sleep("150 millis"))
    expect(fixture.requests.length).toBe(settled)
  })
})

describe("payload schemas", () => {
  const decodeWith = <A>(schema: Schema.Schema<A>, value: unknown) =>
    Effect.runPromise(Effect.exit(Schema.decodeUnknownEffect(schema)(value) as Effect.Effect<A, unknown>))

  const full = {
    message_id: 1,
    date: 2,
    chat: { id: -100, type: "supergroup", title: "ops", username: "ops" },
    from: { id: 7, is_bot: false, first_name: "Will", last_name: "C", username: "will" },
    text: "hello",
    caption: "c",
    message_thread_id: 5,
    is_topic_message: true,
    reply_to_message: { message_id: 0 },
    photo: [{ file_id: "p" }],
    document: { file_id: "d", file_name: "a.txt" },
    unheard_of: true
  }

  it("types a message and keeps unmodelled Bot API fields", async () => {
    const exit = await decodeWith(Payload.Message, full)
    expect(exit._tag).toBe("Success")
    expect(exit._tag === "Success" ? exit.value : undefined).toHaveProperty("unheard_of", true)
  })

  it("types a callback query, a Mini App message, and the raw web_app_data", async () => {
    expect(
      (await decodeWith(Payload.CallbackQuery, {
        id: "q",
        from: { id: 7 },
        data: "sap:t:a",
        message: full
      }))._tag
    ).toBe("Success")
    expect((await decodeWith(Payload.WebAppData, { data: "{}", button_text: "Send" }))._tag).toBe("Success")
    expect(
      (await decodeWith(Payload.WebAppDataMessage, {
        message_id: 1,
        date: 2,
        chat: { id: -100 },
        web_app_data: { data: "{}" }
      }))._tag
    ).toBe("Success")
  })

  it("still rejects a modelled field of the wrong type", async () => {
    expect((await decodeWith(Payload.Message, { ...full, message_id: "one" }))._tag).toBe("Failure")
    expect((await decodeWith(Payload.Chat, { id: "-100" }))._tag).toBe("Failure")
    expect((await decodeWith(Payload.User, { id: 7 }))._tag).toBe("Success")
  })
})
