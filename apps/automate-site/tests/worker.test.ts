import { describe, expect, test } from "bun:test";
import { createAutomateSiteWorker, type AutomateSiteEnv } from "../src/worker.ts";

function makeEnv(): AutomateSiteEnv {
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

describe("automate site worker", () => {
  test("serves the marketing home page", async () => {
    const response = await createAutomateSiteWorker().fetch(new Request("https://automate.smithers.sh/"), makeEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.text()).toContain("Smithers");
  });

  test("falls back to the home page for marketing paths", async () => {
    const response = await createAutomateSiteWorker().fetch(new Request("https://automate.smithers.sh/learn"), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Smithers");
  });

  test("reports health without touching static assets", async () => {
    const response = await createAutomateSiteWorker().fetch(new Request("https://automate.smithers.sh/healthz"), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "automate-site" });
  });
});
