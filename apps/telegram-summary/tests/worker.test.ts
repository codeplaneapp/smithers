import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TelegramSummaryEnv } from "../src/env.ts";
import { ingestTelegramUpdates, runDailyDigest, status } from "../src/service.ts";
import worker from "../src/worker.ts";
import { sqliteD1 } from "./helpers/sqliteD1.ts";

const originalFetch = globalThis.fetch;

function buildEnv(overrides: Partial<TelegramSummaryEnv> = {}): TelegramSummaryEnv {
  return {
    DB: sqliteD1(),
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_SOURCE_CHAT_ID: "-100123",
    TELEGRAM_OUTPUT_CHAT_ID: "-100123",
    KIMI_MODEL: "kimi-k2.6",
    ADMIN_TOKEN: "admin",
    INGEST_CRON: "*/15 * * * *",
    DIGEST_CRON: "0 0 * * *",
    ...overrides,
  };
}

describe("telegram summary worker", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("protects manual mutation endpoints", async () => {
    const env = buildEnv();
    const response = await worker.fetch(new Request("https://telegram-summary.smithers.sh/api/run-digest", { method: "POST" }), env);
    expect(response.status).toBe(401);
  });

  test("rejects a wrong-length bearer token", async () => {
    const env = buildEnv();
    const response = await worker.fetch(
      new Request("https://telegram-summary.smithers.sh/api/ingest", {
        method: "POST",
        headers: { authorization: "Bearer nope" },
      }),
      env,
    );
    expect(response.status).toBe(401);
  });

  test("rejects a same-length wrong bearer token (constant-time compare still denies)", async () => {
    // "admix" is the same byte length as the configured "admin" token, so this
    // exercises the equal-length XOR branch of the constant-time compare.
    const env = buildEnv();
    const response = await worker.fetch(
      new Request("https://telegram-summary.smithers.sh/api/ingest", {
        method: "POST",
        headers: { authorization: "Bearer admix" },
      }),
      env,
    );
    expect(response.status).toBe(401);
  });

  test("authorizes the correct bearer token", async () => {
    const env = buildEnv();
    globalThis.fetch = (async () => Response.json({ ok: true, result: [] })) as unknown as typeof fetch;
    const response = await worker.fetch(
      new Request("https://telegram-summary.smithers.sh/api/ingest", {
        method: "POST",
        headers: { authorization: "Bearer admin" },
      }),
      env,
    );
    expect(response.status).not.toBe(401);
  });

  test("ingests Telegram Bot API updates into D1", async () => {
    const env = buildEnv();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({
        ok: true,
        result:
          calls === 1
            ? [
                {
                  update_id: 10,
                  message: {
                    message_id: 22,
                    date: 1782931200,
                    chat: { id: -100123, title: "Smithers" },
                    from: { first_name: "Antonio" },
                    text: "Could someone summarize this group daily?",
                  },
                },
              ]
            : [],
      });
    }) as unknown as typeof fetch;

    const result = await ingestTelegramUpdates(env, 1782931300000);
    const snapshot = await status(env);

    expect(result.updateCount).toBe(1);
    expect(result.storedMessages).toBe(1);
    expect(snapshot.messages).toBe(1);
    expect(snapshot.lastUpdateId).toBe(10);
  });

  test("daily digest reports missing Kimi key without calling the model", async () => {
    const env = buildEnv({ MOONSHOT_API_KEY: undefined });
    globalThis.fetch = (async () =>
      Response.json({
        ok: true,
        result: [
          {
            update_id: 11,
            message: {
              message_id: 23,
              date: 1782931200,
              chat: { id: -100123, title: "Smithers" },
              from: { username: "gb" },
              text: "This should be a Smithers workflow with a UI.",
            },
          },
        ],
      })) as unknown as typeof fetch;

    await ingestTelegramUpdates(env, 1782931300000);
    const result = await runDailyDigest(env, 1782931400000);

    expect(result.status).toBe("missing-kimi-key");
    expect(result.messageCount).toBe(1);
    expect(result.error).toContain("MOONSHOT_API_KEY");
  });
});
