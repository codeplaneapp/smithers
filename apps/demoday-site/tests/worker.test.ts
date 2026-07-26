import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createDemodaySiteWorker, type DemodaySiteEnv } from "../src/worker.ts";

const indexHtml = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");

function makeEnv(): DemodaySiteEnv {
  return {
    ASSETS: {
      async fetch(request: Request) {
        const url = new URL(request.url);
        if (url.pathname === "/" || url.pathname === "/index.html") {
          return new Response(indexHtml, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (url.pathname === "/shots/home.png") {
          return new Response("png-bytes", {
            headers: { "content-type": "image/png" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    },
  };
}

describe("demoday site worker", () => {
  test("built deck is the Smithers demo-day pitch", () => {
    expect(indexHtml).toContain("<title>Smithers — Demo Day</title>");
    expect(indexHtml).toContain("assets/");
    expect(indexHtml).not.toContain("/Users/");
  });

  test("narration manifest covers all 16 steps and totals 3:00", () => {
    const manifest = JSON.parse(readFileSync(new URL("../dist/narration/manifest.json", import.meta.url), "utf8")) as {
      totalMs: number;
      steps: { file: string; durationMs: number }[];
    };
    expect(manifest.steps.length).toBe(16);
    for (const step of manifest.steps) expect(step.durationMs).toBeGreaterThan(0);
    expect(manifest.totalMs).toBeGreaterThan(170_000);
    expect(manifest.totalMs).toBeLessThanOrEqual(181_000);
  });

  test("serves the deck with cache and security headers", async () => {
    const response = await createDemodaySiteWorker().fetch(new Request("https://demoday.smithers.sh/"), makeEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  test("screenshots get the media cache policy", async () => {
    const response = await createDemodaySiteWorker().fetch(
      new Request("https://demoday.smithers.sh/shots/home.png"),
      makeEnv(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=120");
  });

  test("unknown paths fall back to the deck (SPA)", async () => {
    const response = await createDemodaySiteWorker().fetch(
      new Request("https://demoday.smithers.sh/some/deep/link"),
      makeEnv(),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Smithers — Demo Day");
  });

  test("healthz responds without touching assets", async () => {
    const response = await createDemodaySiteWorker().fetch(
      new Request("https://demoday.smithers.sh/healthz"),
      makeEnv(),
    );
    expect(await response.json()).toEqual({ ok: true, service: "demoday-site" });
  });

  test("non-GET methods are rejected", async () => {
    const response = await createDemodaySiteWorker().fetch(
      new Request("https://demoday.smithers.sh/", { method: "POST" }),
      makeEnv(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});
