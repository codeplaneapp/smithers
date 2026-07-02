import { describe, expect, test } from "bun:test";
import { createPluginsSiteWorker, type PluginsSiteEnv } from "../src/worker.ts";

function makeEnv(): PluginsSiteEnv {
  return {
    ASSETS: {
      async fetch(request: Request) {
        const url = new URL(request.url);
        if (url.pathname === "/" || url.pathname === "/index.html") {
          return new Response("<!doctype html><title>Smithers plugins</title>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    },
  };
}

describe("Plugins site worker", () => {
  test("serves the marketing home page", async () => {
    const response = await createPluginsSiteWorker().fetch(new Request("https://plugins.smithers.sh/"), makeEnv());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.text()).toContain("Smithers");
  });

  test("falls back to the home page for marketing paths", async () => {
    const response = await createPluginsSiteWorker().fetch(
      new Request("https://plugins.smithers.sh/claude-code"),
      makeEnv(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Smithers");
  });

  test("reports health without touching static assets", async () => {
    const response = await createPluginsSiteWorker().fetch(new Request("https://plugins.smithers.sh/healthz"), makeEnv());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "plugins-site" });
  });
});
