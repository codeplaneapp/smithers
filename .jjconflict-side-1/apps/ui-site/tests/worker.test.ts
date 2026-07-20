import { describe, expect, test } from "bun:test";
import { createUiSiteWorker, type UiSiteEnv } from "../src/worker.ts";

function makeEnv(): UiSiteEnv {
  return {
    ASSETS: {
      async fetch(request: Request) {
        const url = new URL(request.url);
        if (url.pathname === "/" || url.pathname === "/index.html") {
          return new Response("<!doctype html><title>Smithers</title>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (url.pathname.startsWith("/assets/")) {
          return new Response("body{}", {
            headers: { "content-type": "text/css; charset=utf-8" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    },
  };
}

describe("ui site worker", () => {
  test("serves the marketing home page", async () => {
    const response = await createUiSiteWorker().fetch(new Request("https://ui.smithers.sh/"), makeEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.text()).toContain("Smithers");
  });

  test("falls back to the home page for marketing paths", async () => {
    const response = await createUiSiteWorker().fetch(new Request("https://ui.smithers.sh/learn"), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Smithers");
  });

  test("rejects non-GET/HEAD methods with 405", async () => {
    const response = await createUiSiteWorker().fetch(
      new Request("https://ui.smithers.sh/", { method: "POST" }),
      makeEnv(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("method not allowed");
  });

  test("serves fingerprinted assets with immutable caching", async () => {
    const response = await createUiSiteWorker().fetch(
      new Request("https://ui.smithers.sh/assets/app.css"),
      makeEnv(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("body{}");
  });

  test("reports health without touching static assets", async () => {
    const response = await createUiSiteWorker().fetch(new Request("https://ui.smithers.sh/healthz"), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "ui-site" });
  });
});
