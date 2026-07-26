// Coverage for the Telegram pure-logic units: the client Layer + fetch/json
// error catches, the poll-failed mapError, the update→events thread/web-app/
// callback variants, the approval codec/keyboard/approver-label branches, the
// chunk single-line boundary, the config resolution throw, the markdown empty
// code-escape guard, and the Mini App initData verification edge cases
// (HMAC + Ed25519). Real fixture Bot API + real Web Crypto — no mocks.
import { afterAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Chunk, Effect, Schedule, Stream } from "effect";
import { startTelegramFixture } from "./telegram-fixture.js";
import { TelegramClient, TelegramClientLive, makeTelegramClient } from "../src/telegram/TelegramClient.js";
import {
  TELEGRAM_CALLBACK_QUERY_EVENT,
  TELEGRAM_WEB_APP_DATA_EVENT,
  makeTelegramSource,
  telegramUpdateToEvents,
} from "../src/telegram/TelegramSource.js";
import {
  approvalInlineKeyboard,
  telegramApprovalCallbackData,
  telegramApproverLabel,
} from "../src/telegram/approval.js";
import { chunkTelegramText } from "../src/telegram/chunk.js";
import { convertMarkdownToTelegram } from "../src/telegram/markdown.js";
import { configureTelegram, resolveTelegramConfig } from "../src/telegram/config.js";
import {
  parseTelegramInitData,
  verifyTelegramWebAppInitData,
  verifyTelegramWebAppInitDataSignature,
} from "../src/telegram/initData.js";

const fixture = startTelegramFixture();
afterAll(() => fixture.stop());
const telegramConfig = { botToken: fixture.token, apiBaseUrl: fixture.apiBaseUrl };

describe("TelegramClient layer + transport error catches", () => {
  test("TelegramClientLive provides a client that talks to the fixture", async () => {
    const chunkCount = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TelegramClient;
        const sent = yield* svc.sendMessageSmart(4242, "hi from the layer", { parseMode: "none", typing: false });
        return sent.chunkCount;
      }).pipe(Effect.provide(TelegramClientLive(telegramConfig))),
    );
    expect(chunkCount).toBe(1);
  });

  test("a network failure is wrapped as a TelegramApiError (fetch catch)", async () => {
    const client = makeTelegramClient({ botToken: "42:x", apiBaseUrl: "http://127.0.0.1:1" });
    const error = await Effect.runPromise(client.call("getMe").pipe(Effect.flip));
    expect(error.name).toBe("TelegramApiError");
    expect(error.message).toMatch(/request failed/);
  });

  test("a non-JSON Bot API response is wrapped as a TelegramApiError (json catch)", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("<html>not json</html>", { status: 200 }) });
    try {
      const client = makeTelegramClient({ botToken: "42:x", apiBaseUrl: `http://127.0.0.1:${server.port}` });
      const error = await Effect.runPromise(client.call("getMe").pipe(Effect.flip));
      expect(error.name).toBe("TelegramApiError");
      expect(error.message).toMatch(/non-JSON response/);
    } finally {
      server.stop(true);
    }
  });
});

describe("makeTelegramSource poll failure", () => {
  test("a failing getUpdates surfaces a poll-failed IntegrationError", async () => {
    const fx = startTelegramFixture();
    try {
      fx.queueResponse("getUpdates", { status: 400, body: { ok: false, error_code: 400, description: "Bad Request" } });
      const source = makeTelegramSource({
        botToken: fx.token,
        apiBaseUrl: fx.apiBaseUrl,
        sourceId: "tg-fail",
        pollTimeoutSeconds: 1,
        schedule: Schedule.spaced("20 millis"),
      });
      const error = await Effect.runPromise(Stream.runCollect(Stream.take(source.events, 1)).pipe(Effect.flip));
      expect(error.details?.reason).toBe("poll-failed");
      expect(error.details?.sourceId).toBe("tg-fail");
    } finally {
      fx.stop();
    }
  }, 10_000);
});

describe("telegramUpdateToEvents variant branches", () => {
  test("a message with no chat id emits nothing", () => {
    const events = telegramUpdateToEvents("telegram", { update_id: 1, message: { text: "orphan" } }, 100);
    expect(events).toEqual([]);
  });
  test("web_app_data on a topic message also emits a thread-scoped web_app_data event", () => {
    const events = telegramUpdateToEvents(
      "telegram",
      {
        update_id: 2,
        message: {
          message_id: 1,
          chat: { id: 55, type: "supergroup" },
          message_thread_id: 8,
          web_app_data: { data: "{}", button_text: "Go" },
        },
      },
      100,
    );
    const webApp = events.filter((e) => e.eventName === TELEGRAM_WEB_APP_DATA_EVENT);
    expect(webApp.map((e) => [e.correlationId, e.dedupeKey])).toEqual([
      ["chat:55", "update:2:webappdata"],
      ["chat:55:thread:8", "update:2:webappdata:thread"],
    ]);
  });
  test("a callback_query on a topic message emits a thread-scoped callback event", () => {
    const events = telegramUpdateToEvents(
      "telegram",
      {
        update_id: 3,
        callback_query: {
          id: "cb-3",
          from: { id: 9 },
          data: "x",
          message: { message_id: 2, chat: { id: 77, type: "supergroup" }, message_thread_id: 4 },
        },
      },
      100,
    );
    expect(events.filter((e) => e.eventName === TELEGRAM_CALLBACK_QUERY_EVENT).map((e) => e.correlationId)).toEqual([
      "chat:77",
      "chat:77:thread:4",
    ]);
  });
});

describe("approval codec + keyboard + approver-label branches", () => {
  test("a token containing a colon is rejected", () => {
    expect(() => telegramApprovalCallbackData({ kind: "approve" }, "bad:token")).toThrow(/must not contain a colon/);
  });
  test("an unknown choice kind is rejected", () => {
    expect(() => telegramApprovalCallbackData(/** @type {any} */ ({ kind: "mystery" }), "t")).toThrow(
      /Unknown approval choice/,
    );
  });
  test("select keyboard with no options is rejected", () => {
    expect(() => approvalInlineKeyboard({ mode: "select", token: "t", options: [] })).toThrow(/at least one option/);
  });
  test("telegramApproverLabel: username, numeric id, and empty forms", () => {
    expect(telegramApproverLabel({ from: { username: "will" } })).toBe("@will");
    expect(telegramApproverLabel({ from: { id: 7 } })).toBe("7");
    expect(telegramApproverLabel({ from: {} })).toBeNull();
    expect(telegramApproverLabel({})).toBeNull();
  });
});

describe("chunkTelegramText single line-break boundary", () => {
  test("prefers a single newline when no paragraph break fits", () => {
    const first = "a".repeat(3000);
    const second = "b".repeat(3000);
    const chunks = chunkTelegramText(`${first}\n${second}`);
    expect(chunks).toEqual([first, second]);
  });
});

describe("resolveTelegramConfig throw", () => {
  test("throws when no bot token can be resolved from prop, registry, or env", () => {
    const saved = process.env.SMITHERS_TELEGRAM_BOT_TOKEN;
    delete process.env.SMITHERS_TELEGRAM_BOT_TOKEN;
    configureTelegram(null);
    try {
      expect(() => resolveTelegramConfig({})).toThrow(/No Telegram bot token configured/);
    } finally {
      if (saved !== undefined) process.env.SMITHERS_TELEGRAM_BOT_TOKEN = saved;
    }
  });
});

describe("markdown escape branches", () => {
  test("an empty fenced code block escapes its (empty) body without error", () => {
    // The fenced-code body is empty, so escapeCode receives "" and hits its
    // empty guard.
    expect(convertMarkdownToTelegram("```\n```")).toBe("```\n```");
  });
  test("single-asterisk italic converts to underscore italic", () => {
    // Exercises the single-`*` italic replacement (distinct from `**bold**`).
    expect(convertMarkdownToTelegram("a *italic* b")).toContain("_italic_");
  });
});

// --- Mini App initData verification edge cases -------------------------------

const BOT_TOKEN = "424242:TEST-fixture-bot-token";
const nowSeconds = 1_800_000_000;
const nowMs = nowSeconds * 1000;

function signHmacInitData(fields, botToken) {
  const dcs = Object.keys(fields)
    .filter((key) => key !== "hash")
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(dcs).digest("hex");
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) params.set(key, value);
  params.set("hash", hash);
  return params.toString();
}

/** Run `fn` with globalThis.crypto.subtle removed, then restore it. */
async function withoutWebCrypto(fn) {
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", { value: { subtle: undefined }, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(globalThis, "crypto", { value: original, configurable: true, writable: true });
  }
}

describe("initData: parse + HMAC edge branches", () => {
  test("parseTelegramInitData tolerates a malformed JSON user field", () => {
    const parsed = parseTelegramInitData("user=%7Bnot-json&auth_date=1");
    expect(parsed.user).toBeNull();
    expect(parsed.authDate).toBe(1);
  });
  test("verifyTelegramWebAppInitData requires a bot token", async () => {
    await expect(verifyTelegramWebAppInitData("auth_date=1&hash=x", "")).rejects.toThrow(/requires a bot token/);
  });
  test("verifyTelegramWebAppInitData rejects an empty initData string", async () => {
    await expect(verifyTelegramWebAppInitData("", BOT_TOKEN)).rejects.toThrow(/initData is empty/);
  });
  test("rejects when auth_date is missing but a freshness window is set", async () => {
    await expect(verifyTelegramWebAppInitData("hash=abc&query_id=1", BOT_TOKEN, { nowMs })).rejects.toThrow(
      /expired or missing auth_date/,
    );
  });
  test("rejects a hash whose length does not match the computed digest", async () => {
    const initData = `auth_date=${nowSeconds}&hash=ab`;
    await expect(verifyTelegramWebAppInitData(initData, BOT_TOKEN, { nowMs })).rejects.toThrow(/does not match/);
  });
  test("rejects when Web Crypto is unavailable (HMAC path)", async () => {
    const initData = signHmacInitData({ auth_date: String(nowSeconds) }, BOT_TOKEN);
    await withoutWebCrypto(async () => {
      await expect(verifyTelegramWebAppInitData(initData, BOT_TOKEN, { nowMs })).rejects.toThrow(/Web Crypto/);
    });
  });
});

describe("initData: Ed25519 signature edge branches", () => {
  test("requires a numeric bot id", async () => {
    await expect(verifyTelegramWebAppInitDataSignature("auth_date=1&signature=AAAA", "")).rejects.toThrow(
      /requires a numeric bot id/,
    );
  });
  test("rejects an empty initData string", async () => {
    await expect(verifyTelegramWebAppInitDataSignature("", 42)).rejects.toThrow(/initData is empty/);
  });
  test("rejects a stale signed delivery (freshness check on the signature path)", async () => {
    const initData = `signature=AAAA&auth_date=${nowSeconds - 7200}`;
    await expect(verifyTelegramWebAppInitDataSignature(initData, 42, { nowMs })).rejects.toThrow(
      /expired or missing auth_date/,
    );
  });
  test("rejects when Web Crypto is unavailable (Ed25519 path)", async () => {
    const initData = `signature=AAAA&auth_date=${nowSeconds}`;
    await withoutWebCrypto(async () => {
      await expect(verifyTelegramWebAppInitDataSignature(initData, 42, { nowMs })).rejects.toThrow(/Web Crypto/);
    });
  });
  test("an invalid public key hex surfaces as unsupported (importKey failure path)", async () => {
    const initData = `signature=AAAA&auth_date=${nowSeconds}`;
    await expect(verifyTelegramWebAppInitDataSignature(initData, 42, { nowMs, publicKeyHex: "xyz" })).rejects.toThrow(
      /not supported|Expected an even-length hex/,
    );
  });
});
