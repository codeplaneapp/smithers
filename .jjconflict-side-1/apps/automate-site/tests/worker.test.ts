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

  test("rejects non-GET/HEAD methods with 405", async () => {
    const response = await createAutomateSiteWorker().fetch(
      new Request("https://automate.smithers.sh/", { method: "POST" }),
      makeEnv(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("method not allowed");
  });

  test("serves fingerprinted assets with immutable caching", async () => {
    const env: AutomateSiteEnv = {
      ASSETS: {
        async fetch(request: Request) {
          const url = new URL(request.url);
          if (url.pathname === "/assets/app.abc123.js") {
            return new Response("console.log(1)", {
              headers: { "content-type": "application/javascript" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      },
    };
    const response = await createAutomateSiteWorker().fetch(
      new Request("https://automate.smithers.sh/assets/app.abc123.js"),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("returns the raw 404 when an asset is missing and index also 404s", async () => {
    const env: AutomateSiteEnv = {
      ASSETS: {
        async fetch() {
          return new Response("not found", { status: 404 });
        },
      },
    };
    const response = await createAutomateSiteWorker().fetch(
      new Request("https://automate.smithers.sh/missing.png", { method: "HEAD" }),
      env,
    );
    expect(response.status).toBe(404);
  });
});
