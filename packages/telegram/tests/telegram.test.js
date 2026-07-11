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

  test("caps server-provided retry_after before sleeping", async () => {
    const sleeps = [];
    let attempts = 0;
    const client = createTelegramClient({
      botToken: "token",
      maxRetries: 1,
      maxRetryAfterMs: 250,
      sleep: async (ms) => sleeps.push(ms),
      fetch: async () => {
        attempts += 1;
        return attempts === 1
          ? Response.json(
              { ok: false, description: "slow down", parameters: { retry_after: 86_400 } },
              { status: 429 },
            )
          : Response.json({ ok: true, result: true });
      },
    });
    await expect(client.getMe()).resolves.toBe(true);
    expect(sleeps).toEqual([250]);
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

  test("does not retry permanent Bot API errors", async () => {
    const client = createTelegramClient({
      botToken: "bad",
      fetch: async () => Response.json({ ok: false, description: "Unauthorized" }, { status: 401 }),
    });

    await expect(client.getMe()).rejects.toBeInstanceOf(TelegramBotApiError);
  });

  test("bounds response bodies without retrying a deterministic policy failure", async () => {
    let attempts = 0;
    const client = createTelegramClient({
      botToken: "token",
      maxResponseBytes: 4,
      maxRetries: 3,
      fetch: async () => {
        attempts += 1;
        return new Response("12345", { headers: { "content-length": "5" } });
      },
    });

    await expect(client.getMe()).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(attempts).toBe(1);
  });

  test("rejects an invalid response cap before calling fetch", () => {
    let attempts = 0;
    expect(() => createTelegramClient({
      botToken: "token",
      maxResponseBytes: -1,
      fetch: async () => {
        attempts += 1;
        return Response.json({ ok: true, result: true });
      },
    })).toThrow(expect.objectContaining({
      code: "INVALID_OPTION",
      details: { option: "maxResponseBytes" },
    }));
    expect(attempts).toBe(0);
  });

  test("redacts the path-embedded bot token from redirect policy errors", async () => {
    const token = "123456:bot-secret";
    const client = createTelegramClient({
      botToken: token,
      apiRoot: "https://telegram.example",
      maxRetries: 3,
      fetch: async () => new Response(null, {
        status: 307,
        headers: { location: "https://attacker.example/steal" },
      }),
    });

    let caught;
    try {
      await client.getMe();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "CROSS_ORIGIN_BODY_BLOCKED" });
    expect(JSON.stringify(caught)).not.toContain(token);
    expect(caught.details.from).toBe("https://telegram.example");
  });

  test("blocks an untrusted redirect into a private destination", async () => {
    let calls = 0;
    const client = createTelegramClient({
      botToken: "123456:bot-secret",
      apiRoot: "https://telegram.example",
      maxRetries: 0,
      fetch: async () => {
        calls += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "https://10.0.0.1/private" },
        });
      },
    });
    await expect(client.getMe()).rejects.toMatchObject({
      code: "INVALID_URL",
      details: { reason: "non-public-destination" },
    });
    expect(calls).toBe(1);
  });

  test("redacts bot tokens reflected in parsed, invalid, and successful response bodies", async () => {
    const token = "123456:bot-secret";
    for (const [body, status] of [
      [JSON.stringify({ ok: false, error_code: 400, description: `echo ${token}`, nested: { token } }), 400],
      [`not-json ${token}`, 200],
    ]) {
      const client = createTelegramClient({
        botToken: token,
        maxRetries: 0,
        fetch: async () => new Response(body, { status }),
      });
      let caught;
      try {
        await client.getMe();
      } catch (error) {
        caught = error;
      }
      expect(JSON.stringify(caught)).not.toContain(token);
      expect(caught?.message).not.toContain(token);
    }

    const success = createTelegramClient({
      botToken: token,
      fetch: async () => Response.json({ ok: true, result: { echoed: token } }),
    });
    await expect(success.getMe()).resolves.toEqual({ echoed: "<redacted>" });
  });

  test("propagates abort during fetch without retrying", async () => {
    const controller = new AbortController();
    let attempts = 0;
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const client = createTelegramClient({
      botToken: "token",
      fetch: async (_url, init) => {
        attempts += 1;
        markStarted();
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
      },
    });
    const pending = client.getMe({ signal: controller.signal });
    await started;
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(attempts).toBe(1);
  });

  test("propagates abort during response consumption without retrying", async () => {
    const controller = new AbortController();
    let attempts = 0;
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const client = createTelegramClient({
      botToken: "token",
      fetch: async () => {
        attempts += 1;
        markStarted();
        return new Response(new ReadableStream({ start() {} }));
      },
    });
    const pending = client.getMe({ signal: controller.signal });
    await started;
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(attempts).toBe(1);
  });

  test("aborts retry backoff promptly and prevents another request", async () => {
    const controller = new AbortController();
    let attempts = 0;
    let enteredSleep;
    const sleeping = new Promise((resolve) => {
      enteredSleep = resolve;
    });
    const client = createTelegramClient({
      botToken: "token",
      maxRetries: 3,
      sleep: async () => {
        enteredSleep();
        return new Promise(() => {});
      },
      fetch: async () => {
        attempts += 1;
        return Response.json(
          { ok: false, description: "slow down", parameters: { retry_after: 10 } },
          { status: 429 },
        );
      },
    });
    const pending = client.getMe({ signal: controller.signal });
    await sleeping;
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(attempts).toBe(1);
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
