import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { resolve } from "../src/telegram/Config.ts"
import { isTelegramApiError, make, redactBotToken } from "../src/telegram/TelegramClient.ts"
import { type Fixture, json, startFixture } from "./Fixture.ts"

const TOKEN = "123456:AA-bot-token"

let fixture: Fixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

const client = (extra: { readonly maxRateLimitRetries?: number; readonly maxRetryAfterSeconds?: number } = {}) =>
  make({ botToken: TOKEN, apiBaseUrl: (fixture as Fixture).origin, ...extra })

const method = (url: string): string => url.split("/").pop() ?? ""

const ok = (result: unknown) => ({ ok: true, result })

describe("Telegram config", () => {
  it("takes the token from the environment when the caller passes none", () => {
    expect(resolve({}, { SMITHERS_TELEGRAM_BOT_TOKEN: TOKEN }).botToken).toBe(TOKEN)
    expect(resolve({ botToken: "explicit" }, { SMITHERS_TELEGRAM_BOT_TOKEN: TOKEN }).botToken).toBe("explicit")
  })

  it("names the ways to supply a token, and quotes none of it", () => {
    expect(() => resolve({}, {})).toThrow(/SMITHERS_TELEGRAM_BOT_TOKEN/)
    expect(() => make({ botToken: "" })).toThrow(/requires a bot token/)
  })
})

describe("redactBotToken", () => {
  it("removes the literal token and any bot path segment", () => {
    expect(redactBotToken(`failed at https://api.telegram.org/bot${TOKEN}/sendMessage`, TOKEN))
      .toBe("failed at https://api.telegram.org/bot<redacted>/sendMessage")
    expect(redactBotToken("connect ECONNREFUSED /bot999:other/x", TOKEN))
      .toBe("connect ECONNREFUSED /bot<redacted>/x")
  })

  it("leaves text alone when there is no token to remove", () => {
    expect(redactBotToken("plain", "")).toBe("plain")
  })
})

describe("TelegramClient over a real HTTP server", () => {
  it("posts to /bot<token>/<method> with a JSON body", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, ok({ message_id: 1 })))
    expect(await Effect.runPromise(client().call("getMe"))).toEqual({ message_id: 1 })
    expect(fixture.requests[0]?.url).toBe(`/bot${TOKEN}/getMe`)
    expect(fixture.requests[0]?.headers["content-type"]).toBe("application/json")
  })

  it("fails with the API's own error code and description, redacted", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 400, { ok: false, error_code: 400, description: `bad token ${TOKEN}` })
    )
    const failure = await Effect.runPromise(Effect.flip(client().call("sendMessage")))
    expect(isTelegramApiError(failure)).toBe(true)
    expect(failure.message).not.toContain(TOKEN)
    expect(failure.message).toContain("<redacted>")
    expect(JSON.stringify(failure.details)).not.toContain(TOKEN)
  })

  it("reports a non-JSON body and a transport failure without the token", async () => {
    fixture = await startFixture((_request, response) => {
      response.writeHead(502, { "content-type": "text/html" })
      response.end("<html>bad gateway</html>")
    })
    const nonJson = await Effect.runPromise(Effect.flip(client().call("getMe")))
    expect(nonJson.message).toContain("non-JSON")

    const closed = await startFixture((_request, response) => {
      response.end()
    })
    const origin = closed.origin
    await closed.close()
    const transport = await Effect.runPromise(
      Effect.flip(make({ botToken: TOKEN, apiBaseUrl: origin }).call("getMe"))
    )
    expect(transport.message).not.toContain(TOKEN)
  })

  it("retries a 429 for the capped retry_after, then gives up", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      if (calls === 1) {
        json(response, 429, {
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 0 }
        })
        return
      }
      json(response, 200, ok({ message_id: 1 }))
    })
    expect(await Effect.runPromise(client().call("sendMessage"))).toEqual({ message_id: 1 })
    expect(calls).toBe(2)

    await fixture.close()
    fixture = await startFixture((_request, response) =>
      json(response, 429, {
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 0 }
      })
    )
    const failure = await Effect.runPromise(
      Effect.flip(client({ maxRateLimitRetries: 1 }).call("sendMessage"))
    )
    expect(isTelegramApiError(failure) && failure.errorCode).toBe(429)
    expect(fixture.requests).toHaveLength(2)
  })

  it("does not retry a 400", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 400, { ok: false, error_code: 400, description: "chat not found" })
    )
    await Effect.runPromise(Effect.flip(client().call("sendMessage")))
    expect(fixture.requests).toHaveLength(1)
  })

  it("sends a typing action, then one message per chunk", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, ok({ message_id: 1 })))
    const result = await Effect.runPromise(
      client().sendMessageSmart(42, "a".repeat(5000), { parseMode: "none" })
    )
    expect(result.chunkCount).toBe(2)
    expect(result.chatId).toBe("42")
    expect(result.messageIds).toEqual([1, 1])
    expect(fixture.requests.map((request) => method(request.url)))
      .toEqual(["sendChatAction", "sendMessage", "sendMessage"])
  })

  it("skips the typing action on request and survives one that fails", async () => {
    fixture = await startFixture((request, response) => {
      if (method(request.url) === "sendChatAction") {
        json(response, 400, { ok: false, error_code: 400, description: "no" })
        return
      }
      json(response, 200, ok({ message_id: 1 }))
    })
    await Effect.runPromise(client().sendMessageSmart(42, "hi", { typing: false }))
    expect(fixture.requests.map((request) => method(request.url))).toEqual(["sendMessage"])

    await Effect.runPromise(client().sendMessageSmart(42, "hi"))
    expect(fixture.requests.map((request) => method(request.url)).slice(1))
      .toEqual(["sendChatAction", "sendMessage"])
  })

  it("sends nothing at all for empty text", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, ok({ message_id: 1 })))
    const result = await Effect.runPromise(client().sendMessageSmart(42, ""))
    expect(result).toEqual({ chatId: "42", messageIds: [], chunkCount: 0, usedPlainTextFallback: false })
    expect(fixture.requests).toHaveLength(0)
  })

  // Formatting failure should cost formatting, not the message.
  it("resends a chunk as plain text when Telegram rejects the entities", async () => {
    fixture = await startFixture((request, response) => {
      if (method(request.url) !== "sendMessage") {
        json(response, 200, ok({}))
        return
      }
      const body = JSON.parse(request.body) as { parse_mode?: string }
      if (body.parse_mode !== undefined) {
        json(response, 400, { ok: false, error_code: 400, description: "can't parse entities: bad offset" })
        return
      }
      json(response, 200, ok({ message_id: 9 }))
    })
    const result = await Effect.runPromise(client().sendMessageSmart(42, "**bold**"))
    expect(result.usedPlainTextFallback).toBe(true)
    expect(result.messageIds).toEqual([9])
    const plain = fixture.requests.filter((request) => method(request.url) === "sendMessage").at(-1)
    expect(JSON.parse(plain?.body ?? "{}").text).toBe("**bold**")
  })

  it("does not fall back for an unrelated 400", async () => {
    fixture = await startFixture((request, response) =>
      method(request.url) === "sendMessage"
        ? json(response, 400, { ok: false, error_code: 400, description: "chat not found" })
        : json(response, 200, ok({}))
    )
    const failure = await Effect.runPromise(Effect.flip(client().sendMessageSmart(42, "hi")))
    expect(failure.message).toContain("chat not found")
  })

  it("puts the reply on the first chunk and the keyboard on the last", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, ok({ message_id: 1 })))
    await Effect.runPromise(
      client().sendMessageSmart(42, "a".repeat(5000), {
        parseMode: "none",
        replyToMessageId: 7,
        messageThreadId: 3,
        inlineKeyboard: [[{ text: "ok", callback_data: "x" }]],
        disableNotification: true
      })
    )
    const sends = fixture.requests.filter((request) => method(request.url) === "sendMessage")
      .map((request) => JSON.parse(request.body) as Record<string, unknown>)
    expect(sends[0]).toMatchObject({ reply_to_message_id: 7, message_thread_id: 3, disable_notification: true })
    expect(sends[0]).not.toHaveProperty("reply_markup")
    expect(sends.at(-1)).toHaveProperty("reply_markup")
    expect(sends.at(-1)).not.toHaveProperty("reply_to_message_id")
  })

  it("converts markdown by default and passes an explicit parse mode through", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, ok({ message_id: 1 })))
    await Effect.runPromise(client().sendMessageSmart(42, "**bold**"))
    const converted = JSON.parse(
      fixture.requests.filter((request) => method(request.url) === "sendMessage")[0]?.body ?? "{}"
    ) as { text: string; parse_mode: string }
    expect(converted).toEqual({ chat_id: 42, text: "*bold*", parse_mode: "MarkdownV2" })

    await Effect.runPromise(client().sendMessageSmart(42, "<b>x</b>", { parseMode: "HTML", typing: false }))
    const html = JSON.parse(fixture.requests.at(-1)?.body ?? "{}") as { parse_mode: string; text: string }
    expect(html).toMatchObject({ parse_mode: "HTML", text: "<b>x</b>" })
  })

  it("edits a message in place, with the same fallback", async () => {
    fixture = await startFixture((request, response) => {
      const body = JSON.parse(request.body) as { parse_mode?: string }
      if (body.parse_mode !== undefined) {
        json(response, 400, { ok: false, error_code: 400, description: "can't parse entities" })
        return
      }
      json(response, 200, ok({ message_id: 5 }))
    })
    expect(await Effect.runPromise(client().editMessageSmart(42, 5, "**bold**"))).toEqual({ message_id: 5 })
    expect(JSON.parse(fixture.requests.at(-1)?.body ?? "{}").text).toBe("**bold**")
  })

  it("edits without a parse mode and attaches a keyboard when asked", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, ok({ message_id: 5 })))
    await Effect.runPromise(
      client().editMessageSmart(42, 5, "raw", {
        parseMode: "none",
        inlineKeyboard: [[{ text: "ok", callback_data: "x" }]]
      })
    )
    expect(JSON.parse(fixture.requests[0]?.body ?? "{}")).toEqual({
      chat_id: 42,
      message_id: 5,
      text: "raw",
      reply_markup: { inline_keyboard: [[{ text: "ok", callback_data: "x" }]] }
    })
  })

  it("surfaces an edit failure that is not a parse rejection", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 400, { ok: false, error_code: 400, description: "message is not modified" })
    )
    const failure = await Effect.runPromise(Effect.flip(client().editMessageSmart(42, 5, "same")))
    expect(failure.message).toContain("not modified")
  })

  it("sends a document by URL as JSON and raw bytes as multipart", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, ok({ message_id: 3 })))
    await Effect.runPromise(
      client().sendDocument(42, "https://x.example/a.pdf", {
        caption: "a **report**",
        replyToMessageId: 1,
        messageThreadId: 2
      })
    )
    expect(JSON.parse(fixture.requests[0]?.body ?? "{}")).toMatchObject({
      chat_id: 42,
      document: "https://x.example/a.pdf",
      caption: "a *report*",
      parse_mode: "MarkdownV2",
      reply_to_message_id: 1,
      message_thread_id: 2
    })

    await Effect.runPromise(client().sendDocument(42, { filename: "a.txt", content: "hello" }))
    expect(fixture.requests[1]?.headers["content-type"]).toContain("multipart/form-data")
    expect(fixture.requests[1]?.body).toContain("hello")
    expect(fixture.requests[1]?.body).toContain("filename=\"a.txt\"")

    await Effect.runPromise(
      client().sendDocument(42, {
        filename: "a.bin",
        content: new TextEncoder().encode("bytes"),
        contentType: "application/octet-stream"
      })
    )
    expect(fixture.requests[2]?.body).toContain("bytes")
  })

  it("answers a callback query and a Mini App query", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, ok(true)))
    await Effect.runPromise(client().answerCallbackQuery("q1", { text: "done", showAlert: true }))
    expect(JSON.parse(fixture.requests[0]?.body ?? "{}"))
      .toEqual({ callback_query_id: "q1", text: "done", show_alert: true })

    await Effect.runPromise(client().answerCallbackQuery("q2"))
    expect(JSON.parse(fixture.requests[1]?.body ?? "{}")).toEqual({ callback_query_id: "q2" })

    await Effect.runPromise(client().answerWebAppQuery("w1", { type: "article", id: "1" }))
    expect(JSON.parse(fixture.requests[2]?.body ?? "{}"))
      .toEqual({ web_app_query_id: "w1", result: { type: "article", id: "1" } })
  })

  it("interrupting the fiber aborts the request in flight", async () => {
    let closed = false
    fixture = await startFixture((_request, response) => {
      response.on("close", () => {
        closed = true
      })
    })
    const exit = await Effect.runPromise(Effect.exit(Effect.timeout(client().call("getMe"), "50 millis")))
    expect(exit._tag).toBe("Failure")
    await Effect.runPromise(Effect.sleep("100 millis"))
    expect(closed).toBe(true)
  })
})
