import { afterEach, describe, expect, test } from "bun:test";
import type { TelegramSummaryEnv } from "../src/env.ts";
import {
  digestJsonFromRow,
  ingestTelegramUpdates,
  latestDigest,
  listDigests,
  runDailyDigest,
  status,
} from "../src/service.ts";
import { sqliteD1 } from "./helpers/sqliteD1.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function buildEnv(overrides: Partial<TelegramSummaryEnv> = {}): TelegramSummaryEnv {
  return {
    DB: sqliteD1(),
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_SOURCE_CHAT_ID: "-100123",
    TELEGRAM_OUTPUT_CHAT_ID: "-100123",
    MOONSHOT_API_KEY: "moon-key",
    KIMI_MODEL: "kimi-k2.6",
    ADMIN_TOKEN: "admin",
    INGEST_CRON: "*/15 * * * *",
    DIGEST_CRON: "0 0 * * *",
    ...overrides,
  };
}

type FetchLike = typeof globalThis.fetch;

// A router that returns a stubbed object whose .json() resolves to `body`.
// This mirrors the pattern the existing worker.test.ts already uses.
function routeFetch(route: (url: string) => { ok?: boolean; status?: number; body: unknown }): FetchLike {
  return (async (input: Request | string | URL) => {
    const url = String(input);
    const { ok = true, status = 200, body } = route(url);
    return { ok, status, json: async () => body } as unknown as Response;
  }) as unknown as FetchLike;
}

function telegramUpdates(body: unknown): FetchLike {
  return routeFetch(() => ({ body }));
}

describe("service ingest", () => {
  test("warns when the telegram token is missing", async () => {
    const env = buildEnv({ TELEGRAM_BOT_TOKEN: "  " });
    const result = await ingestTelegramUpdates(env, 1782931300000);
    expect(result.warning).toContain("TELEGRAM_BOT_TOKEN");
    expect(result.batches).toBe(0);
    expect(result.storedMessages).toBe(0);
  });

  test("parses every telegram message shape", async () => {
    // No source chat so wantedChat is null and messageMatchesChat returns true.
    const env = buildEnv({ TELEGRAM_SOURCE_CHAT_ID: undefined, TELEGRAM_OUTPUT_CHAT_ID: undefined });

    // A circular update forces safeJson into its catch branch.
    const circular: Record<string, unknown> = {
      update_id: 100,
      message: { message_id: 1, chat: { id: 5 }, from: { first_name: "Circ" }, text: "circular" },
    };
    (circular.message as Record<string, unknown>).self = circular;

    const firstPage = {
      ok: true,
      result: [
        // text as array with string, {text}, and a non-text part
        {
          update_id: 101,
          message: {
            message_id: 2,
            date: 1782931200,
            chat: { id: -100123, username: "smithers" },
            from: { first_name: "Ann", last_name: "Lee" },
            text: ["hello ", { text: "world" }, 42],
          },
        },
        // caption fallback + sender_chat author + edited_message container
        {
          update_id: 102,
          edited_message: {
            message_id: 3,
            chat: { username: "channel" },
            sender_chat: { title: "Chan" },
            caption: "a caption",
          },
        },
        // channel_post container, no date -> atMs null
        { update_id: 103, channel_post: { message_id: 4, chat: { id: 9 }, text: "channel text" } },
        // edited_channel_post container, username-only author
        {
          update_id: 104,
          edited_channel_post: { message_id: 5, chat: { id: 9 }, from: { username: "bob" }, text: "edited" },
        },
        // empty text after trimming -> filtered out (returns null)
        { update_id: 105, message: { message_id: 6, chat: { id: 9 }, from: { first_name: "" }, text: "   " } },
        // chat record without id or username -> chatId null
        { update_id: 107, message: { message_id: 7, chat: { title: "NoIdChat" }, from: { first_name: "Z" }, text: "no chat id" } },
        // non-number update_id -> null
        { update_id: "nope", message: { chat: { id: 9 }, text: "x" } },
        // no message container -> null
        { update_id: 106, poll: {} },
        circular,
      ],
    };
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      const body = calls === 1 ? firstPage : { ok: true, result: [] };
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as FetchLike;

    const result = await ingestTelegramUpdates(env, 1782931300000);
    expect(result.updateCount).toBe(9);
    // 6 parseable messages stored (the two nulls + empty-text one dropped)
    expect(result.storedMessages).toBe(6);
    expect(result.lastUpdateId).toBe(107);
  });

  test("skips insert when every update is filtered out by chat", async () => {
    const env = buildEnv({ TELEGRAM_SOURCE_CHAT_ID: "-999" });
    globalThis.fetch = telegramUpdates({
      ok: true,
      result: [
        {
          update_id: 200,
          message: { message_id: 1, date: 1782931200, chat: { id: -100123 }, from: { first_name: "X" }, text: "hi" },
        },
      ],
    });
    const result = await ingestTelegramUpdates(env, 1782931300000);
    expect(result.updateCount).toBe(1);
    expect(result.storedMessages).toBe(0);
  });

  test("paginates a full page then stops on an empty page", async () => {
    const env = buildEnv({ TELEGRAM_SOURCE_CHAT_ID: undefined });
    const fullPage = Array.from({ length: 100 }, (_value, index) => ({
      update_id: 1000 + index,
      message: { message_id: index, chat: { id: 7 }, from: { first_name: `U${index}` }, text: `msg ${index}` },
    }));
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => (calls === 1 ? { ok: true, result: fullPage } : { ok: true, result: [] }),
      } as unknown as Response;
    }) as unknown as FetchLike;

    const result = await ingestTelegramUpdates(env, 1782931300000);
    expect(result.batches).toBe(1);
    expect(result.updateCount).toBe(100);
    expect(result.storedMessages).toBe(100);
    expect(result.lastUpdateId).toBe(1099);
  });

  test("resumes from a stored last_update_id offset", async () => {
    const env = buildEnv({ TELEGRAM_SOURCE_CHAT_ID: undefined });
    globalThis.fetch = telegramUpdates({
      ok: true,
      result: [{ update_id: 300, message: { chat: { id: 1 }, from: { first_name: "A" }, text: "first" } }],
    });
    await ingestTelegramUpdates(env, 1782931300000);
    // second ingest sees the stored offset (Number.isFinite branch of the offset math)
    globalThis.fetch = telegramUpdates({ ok: true, result: [] });
    const result = await ingestTelegramUpdates(env, 1782931400000);
    expect(result.updateCount).toBe(0);
    const snapshot = await status(env);
    expect(snapshot.lastUpdateId).toBe(300);
  });
});

// ---- digest flow ----

const richContent = JSON.stringify({
  headline: "Daily Recap",
  summary: Array.from({ length: 300 }, () => "This is a sentence describing what happened today.").join("\n"),
  topics: [
    "not-a-record",
    {
      title: "Topic One",
      summary: "Discussed the roadmap.",
      keyPoints: ["a", "b", "c", "d", "e", 7],
      participants: ["@ann"],
      followUps: ["ship it"],
    },
    { summary: 12 },
  ],
  actionItems: ["do the thing", 5],
  openQuestions: ["what next?"],
  notableLinks: [
    "skip-string",
    { label: "Docs", url: "https://example.com", context: "why" },
    { label: "NoUrl" },
  ],
  caveats: ["low confidence"],
});

function kimiAndTelegramFetch(options: {
  kimi?: { ok?: boolean; status?: number; body?: unknown };
  send?: { ok?: boolean; status?: number; body?: unknown };
} = {}): FetchLike {
  const kimi = options.kimi ?? {
    ok: true,
    status: 200,
    body: { choices: [{ message: { content: richContent } }] },
  };
  const send = options.send ?? { ok: true, status: 200, body: { ok: true, result: {} } };
  return routeFetch((url) => {
    if (url.includes("moonshot")) return { ok: kimi.ok ?? true, status: kimi.status ?? 200, body: kimi.body };
    return { ok: send.ok ?? true, status: send.status ?? 200, body: send.body };
  });
}

async function seedNoDateMessages(env: TelegramSummaryEnv, count: number, hugeIndex = -1): Promise<void> {
  const updates = Array.from({ length: count }, (_value, index) => ({
    update_id: 5000 + index,
    message: {
      message_id: index,
      chat: { id: -100123, username: "smithers" },
      from: { first_name: `Seed${index}` },
      text: index === hugeIndex ? "z".repeat(130000) : `seed message ${index}`,
    },
  }));
  globalThis.fetch = telegramUpdates({ ok: true, result: updates });
  await ingestTelegramUpdates(env, 1782931300000);
}

describe("service digest", () => {
  test("returns empty when no messages fall in the window", async () => {
    const env = buildEnv();
    const result = await runDailyDigest(env, 1782931400000);
    expect(result.status).toBe("empty");
    expect(result.messageCount).toBe(0);
    expect(result.id).toBeNull();
  });

  test("creates, renders, and posts a full digest", async () => {
    const env = buildEnv({ DIGEST_WINDOW_HOURS: "48", DIGEST_TOPIC_HINT: "roadmap", TELEGRAM_OUTPUT_THREAD_ID: "12" });
    await seedNoDateMessages(env, 3, 0); // index 0 is the huge message -> transcript truncation
    // one dated message inside the window to cover the dated transcript branch
    globalThis.fetch = telegramUpdates({
      ok: true,
      result: [
        {
          update_id: 5999,
          message: {
            message_id: 99,
            date: Math.floor(1782931400000 / 1000) - 3600,
            chat: { id: -100123, username: "smithers" },
            from: { first_name: "Dated" },
            text: "dated message https://t.me/smithers/99",
          },
        },
      ],
    });
    await ingestTelegramUpdates(env, 1782931400000);

    globalThis.fetch = kimiAndTelegramFetch();
    const result = await runDailyDigest(env, 1782931400000);
    expect(result.status).toBe("created");
    expect(result.posted).toBe(true);
    expect(result.error).toBeNull();
    expect(result.id).not.toBeNull();

    const latest = await latestDigest(env.DB);
    expect(latest?.id ?? null).toBe(result.id);
    expect(latest?.posted_at_ms).not.toBeNull();
    const parsed = digestJsonFromRow(latest as NonNullable<typeof latest>);
    expect(parsed.headline).toBe("Daily Recap");
    expect(parsed.topics).toHaveLength(2);
    expect(parsed.notableLinks).toHaveLength(1);

    const list = await listDigests(env.DB, 5);
    expect(list).toHaveLength(1);

    const snapshot = await status(env);
    expect(snapshot.digests).toBe(1);
    expect(snapshot.kimiConfigured).toBe(true);
  });

  test("records an error when telegram sendMessage fails", async () => {
    const env = buildEnv();
    await seedNoDateMessages(env, 2);
    globalThis.fetch = kimiAndTelegramFetch({
      send: { ok: false, status: 400, body: { ok: false, description: "chat not found" } },
    });
    const result = await runDailyDigest(env, 1782931400000);
    expect(result.status).toBe("created");
    expect(result.posted).toBe(false);
    expect(result.error).toContain("chat not found");
  });

  test("reports a config error when the output chat/token is missing", async () => {
    const env = buildEnv();
    await seedNoDateMessages(env, 1);
    env.TELEGRAM_BOT_TOKEN = undefined;
    globalThis.fetch = kimiAndTelegramFetch();
    const result = await runDailyDigest(env, 1782931400000);
    expect(result.status).toBe("created");
    expect(result.posted).toBe(false);
    expect(result.error).toContain("Telegram token or output chat id is not configured");
  });

  test("parses prose-wrapped JSON from kimi", async () => {
    const env = buildEnv();
    await seedNoDateMessages(env, 1);
    globalThis.fetch = kimiAndTelegramFetch({
      kimi: { ok: true, status: 200, body: { choices: [{ message: { content: `Sure!\n${richContent}\nDone.` } }] } },
    });
    const result = await runDailyDigest(env, 1782931400000);
    expect(result.status).toBe("created");
  });

  test("fails when kimi returns a non-string content", async () => {
    const env = buildEnv();
    await seedNoDateMessages(env, 1);
    globalThis.fetch = kimiAndTelegramFetch({
      kimi: { ok: true, status: 200, body: { choices: [{ message: { content: { not: "a string" } } }] } },
    });
    const result = await runDailyDigest(env, 1782931400000);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("message content");
  });

  test("fails when kimi returns no JSON object", async () => {
    const env = buildEnv();
    await seedNoDateMessages(env, 1);
    globalThis.fetch = kimiAndTelegramFetch({
      kimi: { ok: true, status: 200, body: { choices: [{ message: { content: "no json here" } }] } },
    });
    const result = await runDailyDigest(env, 1782931400000);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("JSON object");
  });

  test("fails when kimi returns an HTTP error", async () => {
    const env = buildEnv();
    await seedNoDateMessages(env, 1);
    globalThis.fetch = kimiAndTelegramFetch({
      kimi: { ok: false, status: 500, body: { error: { message: "rate limited" } } },
    });
    const result = await runDailyDigest(env, 1782931400000);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("rate limited");
  });

  test("fails when the moonshot key is absent (guard before calling the model)", async () => {
    const env = buildEnv({ MOONSHOT_API_KEY: undefined });
    await seedNoDateMessages(env, 1);
    const result = await runDailyDigest(env, 1782931400000);
    expect(result.status).toBe("missing-kimi-key");
  });
});

describe("service status defaults", () => {
  test("reports null offset and default model on a fresh db", async () => {
    const env = buildEnv({ KIMI_MODEL: undefined, MOONSHOT_API_KEY: undefined, INGEST_CRON: undefined, DIGEST_CRON: undefined });
    const snapshot = await status(env);
    expect(snapshot.messages).toBe(0);
    expect(snapshot.lastUpdateId).toBeNull();
    expect(snapshot.model).toBe("kimi-k2.6");
    expect(snapshot.kimiConfigured).toBe(false);
    expect(snapshot.ingestCron).toBeNull();
    expect(snapshot.digestCron).toBeNull();
    expect(snapshot.latestDigestId).toBeNull();
  });
});
