import { describe, expect, test } from "bun:test";
import {
  FakeTelegramClient,
  TelegramBotApiError,
  TelegramNetworkError,
  createTelegramClient,
  escapeTelegramMarkdownV2,
  isTelegramChatAllowed,
  normalizeTelegramUpdate,
  parseTelegramAllowedChats,
  sendTelegramTextChunks,
  splitTelegramText,
  verifyTelegramWebhookSecret,
} from "../src/index.js";

describe("@smithers-orchestrator/telegram", () => {
  test("verifies Telegram webhook secrets from the official header", () => {
    const request = new Request("https://example.test/webhook", {
      headers: { "x-telegram-bot-api-secret-token": "secret" },
    });

    expect(verifyTelegramWebhookSecret(request, "secret")).toBe(true);
    expect(verifyTelegramWebhookSecret(request, "wrong")).toBe(false);
    expect(verifyTelegramWebhookSecret(request, "")).toBe(false);
  });

  test("normalizes Telegram messages and ignores bot messages by default", () => {
    const normalized = normalizeTelegramUpdate({
      update_id: 42,
      message: {
        message_id: 7,
        message_thread_id: 99,
        date: 1783000000,
        text: " hello   world ",
        chat: { id: -100123, type: "supergroup", title: "Smithers" },
        from: { id: 12, username: "ada", first_name: "Ada", is_bot: false },
      },
    });

    expect(normalized).toMatchObject({
      updateId: 42,
      kind: "message",
      chatId: "-100123",
      chatType: "supergroup",
      chatTitle: "Smithers",
      messageId: 7,
      messageThreadId: 99,
      fromUserId: "12",
      fromUsername: "ada",
      fromDisplayName: "@ada",
      text: "hello world",
      sentAtMs: 1783000000000,
    });

    expect(
      normalizeTelegramUpdate({
        update_id: 43,
        message: {
          message_id: 8,
          date: 1783000001,
          text: "bot chatter",
          chat: { id: -100123 },
          from: { id: 99, is_bot: true },
        },
      }),
    ).toBeNull();
  });

  test("escapes MarkdownV2 text and splits chunks under Telegram limits", () => {
    expect(escapeTelegramMarkdownV2("ship_this [now]!")).toBe("ship\\_this \\[now\\]\\!");
    const chunks = splitTelegramText(`a ${"b".repeat(20)} c`, { maxLength: 10 });
    expect(chunks.every((chunk) => chunk.length <= 10)).toBe(true);
    expect(chunks.join("").replace(/\s/g, "")).toContain("bbbbbbbbbbbbbbbbbbbb");
  });

  test("calls Telegram Bot API with typed helpers", async () => {
    const requests = [];
    const client = createTelegramClient({
      botToken: "token",
      apiRoot: "https://telegram.example",
      fetch: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return Response.json({ ok: true, result: { message_id: 5, chat: { id: 123 }, text: "hi" } });
      },
    });

    const result = await client.sendMessage({ chatId: 123, text: "hi", disableWebPagePreview: true });

    expect(result.message_id).toBe(5);
    expect(requests).toEqual([
      {
        url: "https://telegram.example/bottoken/sendMessage",
        body: {
          chat_id: 123,
          text: "hi",
          disable_web_page_preview: true,
        },
      },
    ]);
  });

  test("retries 429 and 5xx Bot API responses with deterministic sleep", async () => {
    let attempts = 0;
    const sleeps = [];
    const client = createTelegramClient({
      botToken: "token",
      retryBaseMs: 10,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) {
          return Response.json(
            { ok: false, description: "Too Many Requests", parameters: { retry_after: 2 } },
            { status: 429 },
          );
        }
        if (attempts === 2) {
          return Response.json({ ok: false, description: "Bad Gateway" }, { status: 502 });
        }
        return Response.json({ ok: true, result: true });
      },
    });

    await expect(client.setWebhook({ url: "https://example.test/hook" })).resolves.toBe(true);
    expect(sleeps).toEqual([2000, 20]);
  });

  test("caps server-provided retry_after values at maxRetryAfterSeconds", async () => {
    const retryAfterSeconds = [1, 2, 3];
    const sleeps = [];
    let attempts = 0;
    const client = createTelegramClient({
      botToken: "token",
      maxRetries: 3,
      maxRetryAfterSeconds: 2,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetch: async () => {
        const retryAfter = retryAfterSeconds[attempts];
        attempts += 1;
        if (retryAfter !== undefined) {
          return Response.json(
            { ok: false, description: "Too Many Requests", parameters: { retry_after: retryAfter } },
            { status: 429 },
          );
        }
        return Response.json({ ok: true, result: true });
      },
    });

    await expect(client.getMe()).resolves.toBe(true);
    expect(sleeps).toEqual([1000, 2000, 2000]);
    expect(attempts).toBe(4);
  });

  test("aborts promptly during retry sleep without issuing another request", async () => {
    const sleepStarted = Promise.withResolvers();
    const releaseSleep = Promise.withResolvers();
    const controller = new AbortController();
    let attempts = 0;
    const client = createTelegramClient({
      botToken: "token",
      retryBaseMs: 60_000,
      sleep: async () => {
        sleepStarted.resolve(undefined);
        await releaseSleep.promise;
      },
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) {
          return Response.json({ ok: false, description: "Bad Gateway" }, { status: 502 });
        }
        return Response.json({ ok: true, result: true });
      },
    });

    const request = client.getMe({ signal: controller.signal });
    await sleepStarted.promise;
    const abortedAt = Date.now();
    controller.abort();

    const promptTimeoutMs = 1000;
    let timeout;
    const outcome = await Promise.race([
      request.then(
        (value) => ({ status: "resolved", value }),
        (error) => ({ status: "rejected", error }),
      ),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve({ status: "timeout" }), promptTimeoutMs);
      }),
    ]);
    const elapsedMs = Date.now() - abortedAt;
    clearTimeout(timeout);
    releaseSleep.resolve(undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(outcome.status).toBe("rejected");
    expect(outcome.error?.name).toBe("AbortError");
    expect(elapsedMs).toBeLessThan(promptTimeoutMs);
    expect(attempts).toBe(1);
  });

  test("retries network and malformed 5xx Bot API responses", async () => {
    let attempts = 0;
    const sleeps = [];
    const client = createTelegramClient({
      botToken: "token",
      retryBaseMs: 10,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("socket reset");
        if (attempts === 2) return new Response("not json", { status: 502 });
        return Response.json({ ok: true, result: { id: 1, is_bot: true } });
      },
    });

    await expect(client.getMe()).resolves.toEqual({ id: 1, is_bot: true });
    expect(sleeps).toEqual([10, 20]);
  });

  test("propagates response-body AbortError without retrying", async () => {
    let attempts = 0;
    const client = createTelegramClient({
      botToken: "token",
      sleep: async () => {},
      fetch: async () => {
        attempts += 1;
        return {
          ok: true,
          status: 200,
          text: async () => {
            throw new DOMException("body read aborted", "AbortError");
          },
        };
      },
    });

    const error = await client.getMe().catch((cause) => cause);
    expect(error.name).toBe("AbortError");
    expect(error.message).toBe("body read aborted");
    expect(error).not.toBeInstanceOf(TelegramNetworkError);
    expect(attempts).toBe(1);
  });

  test("surfaces network failures after retry budget is exhausted", async () => {
    const client = createTelegramClient({
      botToken: "token",
      maxRetries: 0,
      fetch: async () => {
        throw new TypeError("offline");
      },
    });

    await expect(client.getMe()).rejects.toBeInstanceOf(TelegramNetworkError);
  });

  test("redacts bot tokens from network failure diagnostics", async () => {
    const token = "123456:live_bot-token";
    const client = createTelegramClient({
      botToken: token,
      apiRoot: "https://telegram.example",
      maxRetries: 0,
      fetch: async (url) => {
        const error = new TypeError(`fetch failed for ${url}`);
        error.code = `request-${token}`;
        throw error;
      },
    });

    const error = await client.getMe().catch((cause) => cause);
    expect(error).toBeInstanceOf(TelegramNetworkError);
    const diagnostics = JSON.stringify({
      message: error.message,
      cause: {
        name: error.cause?.name,
        message: error.cause?.message,
        stack: error.cause?.stack,
        code: error.cause?.code,
      },
      details: error.details,
    });
    expect(diagnostics).toContain("<redacted>");
    expect(diagnostics).not.toContain(token);
    expect(diagnostics).not.toContain(`https://telegram.example/bot${token}/getMe`);
  });

  test("redacts bot tokens from AbortError diagnostics without changing abort semantics", async () => {
    const token = "123456:live_abort-token";
    const client = createTelegramClient({
      botToken: token,
      apiRoot: "https://telegram.example",
      maxRetries: 0,
      fetch: async (url) => {
        throw new DOMException(`request aborted for ${url}`, "AbortError");
      },
    });

    const error = await client.getMe().catch((cause) => cause);
    expect(error.name).toBe("AbortError");
    const diagnostics = JSON.stringify({
      name: error.name,
      message: error.message,
      cause: error.cause,
      stack: error.stack,
    });
    expect(diagnostics).toContain("<redacted>");
    expect(diagnostics).not.toContain(token);
    expect(diagnostics).not.toContain(`https://telegram.example/bot${token}/getMe`);
  });

  test("does not retry permanent Bot API errors", async () => {
    const client = createTelegramClient({
      botToken: "bad",
      fetch: async () => Response.json({ ok: false, description: "Unauthorized" }, { status: 401 }),
    });

    await expect(client.getMe()).rejects.toBeInstanceOf(TelegramBotApiError);
  });

  test("parses TELEGRAM_ALLOWED_CHATS and fails closed for malformed policies", () => {
    expect(parseTelegramAllowedChats(undefined)).toEqual({ allowAll: true, chatIds: [], error: null });
    expect(parseTelegramAllowedChats('["-100123", 42]')).toEqual({
      allowAll: false,
      chatIds: ["-100123", "42"],
      error: null,
    });
    expect(isTelegramChatAllowed(-100123, '["-100123"]')).toBe(true);
    expect(isTelegramChatAllowed(99, '["-100123"]')).toBe(false);
    expect(isTelegramChatAllowed(-100123, '"-100123"')).toBe(false);
    expect(isTelegramChatAllowed(-100123, "{")).toBe(false);
  });

  test("fake client records sends and chunk helper preserves order", async () => {
    const fake = new FakeTelegramClient();
    const results = await sendTelegramTextChunks(fake, { chatId: 10, text: "one two three", maxLength: 7 });

    expect(results.map((message) => message.message_id)).toEqual([1, 2]);
    expect(fake.messages.map((message) => message.text)).toEqual(["one two", "three"]);
  });
});
