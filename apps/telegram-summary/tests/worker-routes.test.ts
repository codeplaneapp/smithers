import { afterEach, describe, expect, test } from "bun:test";
import type { ExecutionContextLike, ScheduledControllerLike, TelegramSummaryEnv } from "../src/env.ts";
import worker from "../src/worker.ts";
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
    KIMI_MODEL: "kimi-k2.6",
    ADMIN_TOKEN: "admin",
    INGEST_CRON: "*/15 * * * *",
    DIGEST_CRON: "0 0 * * *",
    ...overrides,
  };
}

const base = "https://telegram-summary.smithers.sh";
const emptyTelegram = (async () =>
  ({ ok: true, status: 200, json: async () => ({ ok: true, result: [] }) }) as unknown as Response) as unknown as typeof fetch;

describe("worker routes", () => {
  test("serves the dashboard at the root", async () => {
    const response = await worker.fetch(new Request(`${base}/`), buildEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  test("serves a health check", async () => {
    const response = await worker.fetch(new Request(`${base}/health`), buildEnv());
    expect(await response.json()).toEqual({ ok: true });
  });

  test("returns status via the api", async () => {
    const response = await worker.fetch(new Request(`${base}/api/status`), buildEnv());
    const body = (await response.json()) as { messages: number };
    expect(body.messages).toBe(0);
  });

  test("returns the latest digest (null when none)", async () => {
    const response = await worker.fetch(new Request(`${base}/api/latest`), buildEnv());
    expect(await response.json()).toEqual({ digest: null });
  });

  test("lists digests honoring a numeric limit", async () => {
    const response = await worker.fetch(new Request(`${base}/api/digests?limit=5`), buildEnv());
    expect(await response.json()).toEqual({ digests: [] });
  });

  test("lists digests falling back on a non-numeric limit", async () => {
    const response = await worker.fetch(new Request(`${base}/api/digests?limit=abc`), buildEnv());
    expect(await response.json()).toEqual({ digests: [] });
  });

  test("runs the digest endpoint when authorized", async () => {
    globalThis.fetch = emptyTelegram;
    const response = await worker.fetch(
      new Request(`${base}/api/run-digest`, { method: "POST", headers: { authorization: "Bearer admin" } }),
      buildEnv(),
    );
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("empty");
  });

  test("returns 404 for an unknown path", async () => {
    const response = await worker.fetch(new Request(`${base}/nope`), buildEnv());
    expect(response.status).toBe(404);
  });

  test("returns 404 for an unknown api path", async () => {
    const response = await worker.fetch(new Request(`${base}/api/unknown`), buildEnv());
    expect(response.status).toBe(404);
  });
});

describe("worker scheduled handler", () => {
  function runScheduled(controller: ScheduledControllerLike, env: TelegramSummaryEnv): Promise<void> {
    let captured: Promise<unknown> = Promise.resolve();
    const ctx: ExecutionContextLike = { waitUntil: (promise) => (captured = promise) };
    worker.scheduled(controller, env, ctx);
    return captured.then(() => undefined);
  }

  test("runs ingest then digest on the digest cron", async () => {
    globalThis.fetch = emptyTelegram;
    const env = buildEnv();
    await runScheduled({ cron: "0 0 * * *", scheduledTime: 1782931400000 }, env);
    const response = await worker.fetch(new Request(`${base}/api/status`), env);
    const body = (await response.json()) as { messages: number };
    expect(body.messages).toBe(0);
  });

  test("runs ingest only on the ingest cron", async () => {
    globalThis.fetch = emptyTelegram;
    const env = buildEnv();
    await runScheduled({ cron: "*/15 * * * *" }, env);
    const response = await worker.fetch(new Request(`${base}/api/status`), env);
    expect(response.status).toBe(200);
  });
});
