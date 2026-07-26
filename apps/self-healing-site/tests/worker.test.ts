import { describe, expect, test } from "bun:test";
import { createSelfHealingSiteWorker, type SelfHealingSiteEnv } from "../src/worker.ts";

function makeEnv(): SelfHealingSiteEnv {
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

describe("self-healing site worker", () => {
  test("serves the marketing home page", async () => {
    const response = await createSelfHealingSiteWorker().fetch(
      new Request("https://self-healing.smithers.sh/"),
      makeEnv(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.text()).toContain("Smithers");
  });

  test("falls back to the home page for marketing paths", async () => {
    const response = await createSelfHealingSiteWorker().fetch(
      new Request("https://self-healing.smithers.sh/learn"),
      makeEnv(),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Smithers");
  });

  test("reports health without touching static assets", async () => {
    const response = await createSelfHealingSiteWorker().fetch(
      new Request("https://self-healing.smithers.sh/healthz"),
      makeEnv(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "self-healing-site" });
  });

  test("rejects non-GET/HEAD methods with 405", async () => {
    const response = await createSelfHealingSiteWorker().fetch(
      new Request("https://self-healing.smithers.sh/", { method: "POST" }),
      makeEnv(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("method not allowed");
  });

  test("serves fingerprinted assets with an immutable cache", async () => {
    const env: SelfHealingSiteEnv = {
      ASSETS: {
        async fetch(request: Request) {
          const url = new URL(request.url);
          if (url.pathname === "/assets/app-abc123.js") {
            return new Response("console.log('hi')", {
              headers: { "content-type": "application/javascript" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      },
    };
    const response = await createSelfHealingSiteWorker().fetch(
      new Request("https://self-healing.smithers.sh/assets/app-abc123.js"),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toContain("console.log");
  });

  test("uses the default export worker instance", async () => {
    const worker = (await import("../src/worker.ts")).default;
    const response = await worker.fetch(new Request("https://self-healing.smithers.sh/healthz"), makeEnv());
    expect(await response.json()).toEqual({ ok: true, service: "self-healing-site" });
  });
});
