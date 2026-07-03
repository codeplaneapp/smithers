import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createTelegramSiteWorker, type TelegramSiteEnv } from "../src/worker.ts";

const BOT_TOKEN = "424242:TEST-fixture-bot-token";

function makeEnv(overrides: Partial<TelegramSiteEnv> = {}): TelegramSiteEnv {
  return {
    ASSETS: {
      async fetch(request: Request) {
        const url = new URL(request.url);
        if (url.pathname === "/" || url.pathname === "/index.html") {
          return new Response("<!doctype html><title>Smithers</title>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        // The real asset server maps /approve.html to /approve (auto html handling).
        if (url.pathname === "/approve" || url.pathname === "/approve.html") {
          return new Response("<!doctype html><title>Approve</title>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    },
    ...overrides,
  };
}

/** Build a valid HMAC-signed initData string (independent oracle, no mocks). */
function signInitData(fields: Record<string, string>, botToken: string): string {
  const dcs = Object.keys(fields)
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

const initDataFields = () => ({
  auth_date: String(Math.floor(Date.now() / 1000)),
  query_id: "AAApprove",
  user: JSON.stringify({ id: 7, username: "will" }),
});

function approveRequest(initData: string | null, body: unknown): Request {
  return new Request("https://telegram.smithers.sh/approve", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(initData ? { authorization: `tma ${initData}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("telegram site worker", () => {
  test("serves the marketing home page", async () => {
    const response = await createTelegramSiteWorker().fetch(new Request("https://telegram.smithers.sh/"), makeEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.text()).toContain("Smithers");
  });

  test("falls back to the home page for marketing paths", async () => {
    const response = await createTelegramSiteWorker().fetch(new Request("https://telegram.smithers.sh/learn"), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Smithers");
  });

  test("redirects /join to the community invite the bare domain used to serve", async () => {
    const response = await createTelegramSiteWorker().fetch(new Request("https://telegram.smithers.sh/join"), makeEnv());
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://t.me/+ANThR9bHDLAwMjUx");
  });

  test("reports health without touching static assets", async () => {
    const response = await createTelegramSiteWorker().fetch(new Request("https://telegram.smithers.sh/healthz"), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "telegram-site" });
  });
});

describe("reference Mini App /approve endpoint", () => {
  const worker = createTelegramSiteWorker();

  test("accepts a validly signed approval and echoes the decision", async () => {
    const initData = signInitData(initDataFields(), BOT_TOKEN);
    const response = await worker.fetch(approveRequest(initData, { requestId: "r-1", decision: "approve" }), makeEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      decision: "approve",
      requestId: "r-1",
      approver: { id: 7, username: "will" },
    });
  });

  test("rejects a tampered initData with 401 and never leaks the token", async () => {
    const initData = signInitData(initDataFields(), BOT_TOKEN);
    const tampered = initData.replace("query_id=AAApprove", "query_id=forged");
    const response = await worker.fetch(approveRequest(tampered, { requestId: "r-1", decision: "approve" }), makeEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }));
    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).toContain("bad_signature");
    expect(text).not.toContain(BOT_TOKEN);
  });

  test("rejects a missing Authorization header with 401", async () => {
    const response = await worker.fetch(approveRequest(null, { decision: "approve" }), makeEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }));
    expect(response.status).toBe(401);
  });

  test("rejects an unknown decision with 400", async () => {
    const initData = signInitData(initDataFields(), BOT_TOKEN);
    const response = await worker.fetch(approveRequest(initData, { decision: "maybe" }), makeEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }));
    expect(response.status).toBe(400);
  });

  test("a JSON null body is a 400, not a 500", async () => {
    const initData = signInitData(initDataFields(), BOT_TOKEN);
    const response = await worker.fetch(approveRequest(initData, null), makeEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }));
    expect(response.status).toBe(400);
  });

  test("returns 503 when no bot token is configured", async () => {
    const initData = signInitData(initDataFields(), BOT_TOKEN);
    const response = await worker.fetch(approveRequest(initData, { decision: "approve" }), makeEnv());
    expect(response.status).toBe(503);
  });

  test("serves the Mini App page on GET /approve", async () => {
    const response = await worker.fetch(new Request("https://telegram.smithers.sh/approve"), makeEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Approve");
  });

  test("rejects non-GET non-POST methods on /approve", async () => {
    const response = await worker.fetch(
      new Request("https://telegram.smithers.sh/approve", { method: "PUT" }),
      makeEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }),
    );
    expect(response.status).toBe(405);
  });
});
