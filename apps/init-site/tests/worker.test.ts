import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createInitSiteWorker, type InitSiteEnv } from "../src/worker.ts";

const homeHtml = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");

function makeEnv(): InitSiteEnv {
  return {
    ASSETS: {
      async fetch(request: Request) {
        const url = new URL(request.url);
        if (url.pathname === "/" || url.pathname === "/index.html") {
          return new Response("<!doctype html><title>Smithers</title>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    },
  };
}

describe("init site worker", () => {
  test("presents Codex as the default detected agent", () => {
    const codexRow = '<div class="item on"><span class="box">[x]</span>codex';
    const claudeRow = '<div class="item"><span class="box">[ ]</span>claude';

    expect(homeHtml).toContain(codexRow);
    expect(homeHtml).toContain(claudeRow);
    expect(homeHtml).toContain("5.6 Sol · Terra · Luna · default");
    expect(homeHtml).toContain('claude<span class="desc">fallback only');
    expect(homeHtml.indexOf(codexRow)).toBeLessThan(homeHtml.indexOf(claudeRow));
  });

  test("serves the marketing home page", async () => {
    const response = await createInitSiteWorker().fetch(new Request("https://init.smithers.sh/"), makeEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.text()).toContain("Smithers");
  });

  test("falls back to the home page for marketing paths", async () => {
    const response = await createInitSiteWorker().fetch(new Request("https://init.smithers.sh/learn"), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Smithers");
  });

  test("reports health without touching static assets", async () => {
    const response = await createInitSiteWorker().fetch(new Request("https://init.smithers.sh/healthz"), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "init-site" });
  });

  test("rejects non-GET/HEAD methods with 405", async () => {
    const response = await createInitSiteWorker().fetch(
      new Request("https://init.smithers.sh/", { method: "POST" }),
      makeEnv(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("method not allowed");
  });

  test("serves static assets with an immutable cache header", async () => {
    const env: InitSiteEnv = {
      ASSETS: {
        async fetch(request: Request) {
          const url = new URL(request.url);
          if (url.pathname === "/assets/app.js") {
            return new Response("console.log('hi')", {
              headers: { "content-type": "text/javascript; charset=utf-8" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      },
    };
    const response = await createInitSiteWorker().fetch(new Request("https://init.smithers.sh/assets/app.js"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("returns the asset 404 unchanged when both direct and index miss", async () => {
    const env: InitSiteEnv = {
      ASSETS: {
        async fetch() {
          return new Response("not found", { status: 404 });
        },
      },
    };
    const response = await createInitSiteWorker().fetch(new Request("https://init.smithers.sh/missing.html"), env);
    expect(response.status).toBe(404);
  });
});
