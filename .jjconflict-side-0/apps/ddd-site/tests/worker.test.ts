import { describe, expect, test } from "bun:test";
import { createDddSiteWorker, type DddSiteEnv } from "../src/worker.ts";

function makeEnv(): DddSiteEnv {
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

describe("ddd site worker", () => {
  test("serves the marketing home page", async () => {
    const response = await createDddSiteWorker().fetch(new Request("https://ddd.smithers.sh/"), makeEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.text()).toContain("Smithers");
  });

  test("falls back to the home page for marketing paths", async () => {
    const response = await createDddSiteWorker().fetch(new Request("https://ddd.smithers.sh/learn"), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Smithers");
  });

  test("reports health without touching static assets", async () => {
    const response = await createDddSiteWorker().fetch(new Request("https://ddd.smithers.sh/healthz"), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "ddd-site" });
  });

  test("rejects non-GET/HEAD methods with 405", async () => {
    const response = await createDddSiteWorker().fetch(
      new Request("https://ddd.smithers.sh/", { method: "POST" }),
      makeEnv(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("method not allowed");
  });

  test("serves hashed assets with immutable cache headers", async () => {
    const env: DddSiteEnv = {
      ASSETS: {
        async fetch() {
          return new Response("body{}", { headers: { "content-type": "text/css" } });
        },
      },
    };
    const response = await createDddSiteWorker().fetch(
      new Request("https://ddd.smithers.sh/assets/app.css"),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("body{}");
  });

  test("returns the 404 asset response verbatim when index is also missing", async () => {
    const env: DddSiteEnv = {
      ASSETS: {
        async fetch() {
          return new Response("nope", { status: 404 });
        },
      },
    };
    const response = await createDddSiteWorker().fetch(
      new Request("https://ddd.smithers.sh/missing"),
      env,
    );
    expect(response.status).toBe(404);
  });

  test("serves HEAD requests", async () => {
    const response = await createDddSiteWorker().fetch(
      new Request("https://ddd.smithers.sh/", { method: "HEAD" }),
      makeEnv(),
    );
    expect(response.status).toBe(200);
  });
});
