import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeTelegramClient, redactBotToken } from "../src/telegram/TelegramClient.js";
import { startTelegramFixture } from "./telegram-fixture.js";

const fixture = startTelegramFixture();
afterAll(() => fixture.stop());

/** @param {Partial<import("../src/telegram/TelegramClient.ts").TelegramClientConfig>} [overrides] */
function makeClient(overrides = {}) {
  return makeTelegramClient({
    botToken: fixture.token,
    apiBaseUrl: fixture.apiBaseUrl,
    ...overrides,
  });
}

describe("TelegramClient.call", () => {
  test("retries a 429 honoring parameters.retry_after", async () => {
    const client = makeClient();
    fixture.queueResponse("answerCallbackQuery", {
      status: 429,
      body: {
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry after 1",
        parameters: { retry_after: 1 },
      },
    });
    const before = fixture.calls("answerCallbackQuery").length;
    const startedAt = Date.now();
    const result = await Effect.runPromise(client.answerCallbackQuery("cb-1"));
    expect(result).toBe(true);
    // Two real HTTP calls, spaced by the server's retry_after with timer jitter tolerance.
    expect(fixture.calls("answerCallbackQuery").length).toBe(before + 2);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(950);
  }, 10_000);
  test("gives up after maxRateLimitRetries and surfaces the 429", async () => {
    const client = makeClient({ maxRateLimitRetries: 1, maxRetryAfterSeconds: 0 });
    for (let i = 0; i < 2; i += 1) {
      fixture.queueResponse("sendChatAction", {
        status: 429,
        body: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 0 } },
      });
    }
    const error = await Effect.runPromise(
      client.call("sendChatAction", { chat_id: 1, action: "typing" }).pipe(Effect.flip),
    );
    expect(error.name).toBe("TelegramApiError");
    expect(/** @type {any} */ (error).errorCode).toBe(429);
  });
  test("non-429 API errors fail without retry and never contain the token", async () => {
    const client = makeClient();
    fixture.queueResponse("sendMessage", {
      status: 403,
      body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
    });
    const before = fixture.calls("sendMessage").length;
    const error = await Effect.runPromise(client.call("sendMessage", { chat_id: 1, text: "x" }).pipe(Effect.flip));
    expect(fixture.calls("sendMessage").length).toBe(before + 1);
    expect(error.message).toContain("Forbidden");
    expect(JSON.stringify({ message: error.message, details: /** @type {any} */ (error).details })).not.toContain(
      fixture.token,
    );
  });
  test("network failures produce an error with the token redacted", async () => {
    const client = makeTelegramClient({
      botToken: fixture.token,
      // Unroutable port — real connection failure whose cause message
      // would normally embed the /bot<token>/ URL.
      apiBaseUrl: "http://127.0.0.1:1",
    });
    const error = await Effect.runPromise(client.call("getMe").pipe(Effect.flip));
    expect(error.message).not.toContain(fixture.token);
  });
  test("redactBotToken strips tokens from URLs and free text", () => {
    expect(redactBotToken(`GET http://api/bot${fixture.token}/sendMessage failed`, fixture.token)).not.toContain(
      fixture.token,
    );
    expect(redactBotToken("http://api/bot99:abc_DEF-123/getMe", "unrelated")).toBe("http://api/bot<redacted>/getMe");
  });
});

describe("TelegramClient.sendMessageSmart", () => {
  test("sends typing action, then chunks in order with reply/keyboard placement", async () => {
    const client = makeClient();
    const before = fixture.requests.length;
    const paragraphA = `first ${"a".repeat(2500)}`;
    const paragraphB = `second ${"b".repeat(2500)}`;
    const result = await Effect.runPromise(
      client.sendMessageSmart(777, `${paragraphA}\n\n${paragraphB}`, {
        parseMode: "none",
        replyToMessageId: 55,
        inlineKeyboard: [[{ text: "OK", callback_data: "ok" }]],
      }),
    );
    const sequence = fixture.requests.slice(before);
    expect(sequence.map((entry) => entry.method)).toEqual(["sendChatAction", "sendMessage", "sendMessage"]);
    expect(sequence[0].body).toMatchObject({ chat_id: 777, action: "typing" });
    const [first, second] = [sequence[1].body, sequence[2].body];
    expect(first.text.startsWith("first ")).toBe(true);
    expect(second.text.startsWith("second ")).toBe(true);
    // reply threading on the first chunk only; keyboard on the last only.
    expect(first.reply_to_message_id).toBe(55);
    expect(second.reply_to_message_id).toBeUndefined();
    expect(first.reply_markup).toBeUndefined();
    expect(second.reply_markup).toEqual({ inline_keyboard: [[{ text: "OK", callback_data: "ok" }]] });
    expect(result.chunkCount).toBe(2);
    expect(result.messageIds).toHaveLength(2);
    expect(result.usedPlainTextFallback).toBe(false);
  });
  test("falls back to plain text on a 400 can't-parse-entities", async () => {
    const client = makeClient();
    fixture.queueResponse("sendMessage", {
      status: 400,
      body: {
        ok: false,
        error_code: 400,
        description: "Bad Request: can't parse entities: Character '.' is reserved and must be escaped",
      },
    });
    const before = fixture.calls("sendMessage").length;
    const result = await Effect.runPromise(client.sendMessageSmart(1, "hello **world**.", { typing: false }));
    const attempts = fixture.calls("sendMessage").slice(before);
    expect(attempts).toHaveLength(2);
    // First attempt: converted MarkdownV2. Second: raw text, no parse_mode.
    expect(attempts[0].body.parse_mode).toBe("MarkdownV2");
    expect(attempts[0].body.text).toBe("hello *world*\\.");
    expect(attempts[1].body.parse_mode).toBeUndefined();
    expect(attempts[1].body.text).toBe("hello **world**.");
    expect(result.usedPlainTextFallback).toBe(true);
  });
  test("typing indicator failures never fail the send", async () => {
    const client = makeClient();
    fixture.queueResponse("sendChatAction", {
      status: 400,
      body: { ok: false, error_code: 400, description: "Bad Request" },
    });
    const result = await Effect.runPromise(client.sendMessageSmart(1, "still delivered", { parseMode: "none" }));
    expect(result.chunkCount).toBe(1);
  });
  test("threads every chunk into a forum topic via message_thread_id", async () => {
    const client = makeClient();
    const before = fixture.requests.length;
    await Effect.runPromise(client.sendMessageSmart(9, "topic reply", { messageThreadId: 321, parseMode: "none" }));
    const sequence = fixture.requests.slice(before);
    expect(sequence[0].body.message_thread_id).toBe(321); // sendChatAction
    expect(sequence[1].body.message_thread_id).toBe(321); // sendMessage
  });
});

describe("TelegramClient.editMessageSmart / sendDocument", () => {
  test("editMessageText falls back to plain on parse rejection", async () => {
    const client = makeClient();
    fixture.queueResponse("editMessageText", {
      status: 400,
      body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
    });
    const before = fixture.calls("editMessageText").length;
    await Effect.runPromise(client.editMessageSmart(5, 42, "edited **now**."));
    const attempts = fixture.calls("editMessageText").slice(before);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].body.parse_mode).toBe("MarkdownV2");
    expect(attempts[1].body.parse_mode).toBeUndefined();
    expect(attempts[1].body.text).toBe("edited **now**.");
    expect(attempts[1].body.message_id).toBe(42);
  });
  test("sendDocument uploads raw content as multipart form data", async () => {
    const client = makeClient();
    const before = fixture.calls("sendDocument").length;
    await Effect.runPromise(
      client.sendDocument(
        8,
        { filename: "report.txt", content: "line1\nline2", contentType: "text/plain" },
        { caption: "the report" },
      ),
    );
    const upload = fixture.calls("sendDocument").slice(before)[0];
    expect(upload.contentType).toContain("multipart/form-data");
    expect(upload.body.chat_id).toBe("8");
    expect(upload.body.document.filename).toBe("report.txt");
    expect(upload.body.document.text).toBe("line1\nline2");
    expect(upload.body.caption).toBe("the report");
  });
  test("sendDocument passes URLs/file_ids through JSON", async () => {
    const client = makeClient();
    const before = fixture.calls("sendDocument").length;
    await Effect.runPromise(client.sendDocument(8, "https://example.com/file.pdf"));
    const call = fixture.calls("sendDocument").slice(before)[0];
    expect(call.contentType).toContain("application/json");
    expect(call.body.document).toBe("https://example.com/file.pdf");
  });
});
