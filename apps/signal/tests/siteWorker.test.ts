import { describe, expect, test } from "bun:test";
import worker from "../site/src/worker";

function mockEnv(kv: Record<string, string>) {
  return {
    ASSETS: {
      async fetch(request: Request) {
        const url = new URL(request.url);
        if (url.pathname === "/index.html")
          return new Response("<html><body>spa shell</body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        return new Response("not found", { status: 404 });
      },
    },
    SIGNAL_REPORTS: {
      async get(key: string) {
        return key in kv ? kv[key]! : null;
      },
    },
  };
}

const SAMPLE_ISSUE = JSON.stringify({ version: 1, date: "2026-07-17", stories: [] });

describe("site worker: /api/issue/latest", () => {
  test("follows the latest date pointer to the dated report", async () => {
    const env = mockEnv({ latest: "2026-07-17", "report:2026-07-17": SAMPLE_ISSUE });
    const response = await worker.fetch(new Request("https://signal.smithers.sh/api/issue/latest"), env as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 1, date: "2026-07-17", stories: [] });
  });

  test("returns 404 when no issue has been published yet", async () => {
    const env = mockEnv({});
    const response = await worker.fetch(new Request("https://signal.smithers.sh/api/issue/latest"), env as never);
    expect(response.status).toBe(404);
  });

  test("returns 404 when the latest pointer is stale and the dated report is missing", async () => {
    const env = mockEnv({ latest: "2026-07-16" });
    const response = await worker.fetch(new Request("https://signal.smithers.sh/api/issue/latest"), env as never);
    expect(response.status).toBe(404);
  });
});

describe("site worker: /api/issue/:date", () => {
  test("returns the dated report when present", async () => {
    const env = mockEnv({ "report:2026-07-17": SAMPLE_ISSUE });
    const response = await worker.fetch(new Request("https://signal.smithers.sh/api/issue/2026-07-17"), env as never);
    expect(response.status).toBe(200);
  });

  test("rejects a non-date-shaped path segment before touching KV", async () => {
    const env = mockEnv({});
    const response = await worker.fetch(new Request("https://signal.smithers.sh/api/issue/not-a-date"), env as never);
    expect(response.status).toBe(400);
  });
});

describe("site worker: /api/archive", () => {
  test("returns the archive-index array", async () => {
    const env = mockEnv({ "archive-index": JSON.stringify(["2026-07-16", "2026-07-17"]) });
    const response = await worker.fetch(new Request("https://signal.smithers.sh/api/archive"), env as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(["2026-07-16", "2026-07-17"]);
  });

  test("returns an empty array when nothing has published yet", async () => {
    const env = mockEnv({});
    const response = await worker.fetch(new Request("https://signal.smithers.sh/api/archive"), env as never);
    expect(await response.json()).toEqual([]);
  });
});

describe("site worker: static assets + SPA fallback", () => {
  test("serves the SPA shell for a client-side route not present as an asset", async () => {
    const env = mockEnv({});
    const response = await worker.fetch(new Request("https://signal.smithers.sh/archive"), env as never);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("spa shell");
  });

  test("/healthz reports ok without touching KV or assets", async () => {
    const env = mockEnv({});
    const response = await worker.fetch(new Request("https://signal.smithers.sh/healthz"), env as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "signal-site" });
  });

  test("rejects non-GET/HEAD methods", async () => {
    const env = mockEnv({});
    const response = await worker.fetch(new Request("https://signal.smithers.sh/", { method: "POST" }), env as never);
    expect(response.status).toBe(405);
  });
});
