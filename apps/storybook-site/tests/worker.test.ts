import { describe, expect, test } from "bun:test";
import { createStorybookSiteWorker, type StorybookSiteEnv } from "../src/worker.ts";

const INDEX_HTML = "<!doctype html><title>Smithers UI Storybook</title>";

function makeEnv(): StorybookSiteEnv {
  return {
    ASSETS: {
      async fetch(request: Request) {
        const url = new URL(request.url);
        if (url.pathname === "/" || url.pathname === "/index.html") {
          return new Response(INDEX_HTML, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (url.pathname === "/iframe.html") {
          return new Response("<!doctype html>preview", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (url.pathname === "/assets/iframe-abc123.js") {
          return new Response("js-bytes", {
            headers: { "content-type": "text/javascript" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    },
  };
}

const worker = createStorybookSiteWorker();

describe("storybook-site worker", () => {
  test("serves the index with security headers and short cache", async () => {
    const response = await worker.fetch(new Request("https://storybook.smithers.sh/"), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(INDEX_HTML);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
  });

  test("serves the preview iframe (frameable by self)", async () => {
    const response = await worker.fetch(new Request("https://storybook.smithers.sh/iframe.html"), makeEnv());
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-src 'self'");
    expect(response.headers.get("x-frame-options")).toBeNull();
  });

  test("hashed assets get immutable caching", async () => {
    const response = await worker.fetch(
      new Request("https://storybook.smithers.sh/assets/iframe-abc123.js"),
      makeEnv(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("unknown paths fall back to the index document", async () => {
    const response = await worker.fetch(
      new Request("https://storybook.smithers.sh/?path=/story/primitives-button--default"),
      makeEnv(),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(INDEX_HTML);
  });

  test("healthz reports the service name", async () => {
    const response = await worker.fetch(new Request("https://storybook.smithers.sh/healthz"), makeEnv());
    expect(await response.json()).toEqual({ ok: true, service: "storybook-site" });
  });

  test("non-GET methods are rejected", async () => {
    const response = await worker.fetch(new Request("https://storybook.smithers.sh/", { method: "POST" }), makeEnv());
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});
