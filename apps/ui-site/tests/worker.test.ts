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

  test("reports health without touching static assets", async () => {
    const response = await createUiSiteWorker().fetch(new Request("https://ui.smithers.sh/healthz"), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "ui-site" });
  });
});
