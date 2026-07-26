import { describe, expect, test } from "bun:test";
import { createFerricSiteWorker, type FerricSiteEnv } from "../src/worker.ts";

function envWith(pages: Record<string, string>): FerricSiteEnv {
  return {
    ASSETS: {
      async fetch(request: Request) {
        const url = new URL(request.url);
        const body = pages[url.pathname];
        if (body === undefined) return new Response("not found", { status: 404 });
        return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
      },
    },
  };
}

describe("ferric-site worker", () => {
  const worker = createFerricSiteWorker();

  test("serves the index page", async () => {
    const env = envWith({ "/index.html": "<!doctype html><title>Ferric</title>" });
    const res = await worker.fetch(new Request("https://ferric.smithers.sh/"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toContain("Ferric");
  });

  test("falls back to index for unknown paths (single-page behavior)", async () => {
    const env = envWith({ "/index.html": "<!doctype html><title>Ferric</title>" });
    const res = await worker.fetch(new Request("https://ferric.smithers.sh/plan"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Ferric");
  });

  test("serves the source browser at the extensionless /source", async () => {
    const env = envWith({
      "/index.html": "<!doctype html><title>Ferric</title>",
      "/source.html": "<!doctype html><title>Ferric source</title>",
    });
    for (const path of ["/source", "/source/"]) {
      const res = await worker.fetch(new Request(`https://ferric.smithers.sh${path}`), env);
      expect(res.status).toBe(200);
      // Must be the source page, never the single-page fallback to the overview.
      expect(await res.text()).toContain("Ferric source");
    }
  });

  test("serves hashed assets with immutable caching", async () => {
    const env = envWith({ "/assets/app.css": "body{}" });
    const res = await worker.fetch(new Request("https://ferric.smithers.sh/assets/app.css"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("exposes a health endpoint", async () => {
    const res = await worker.fetch(new Request("https://ferric.smithers.sh/healthz"), envWith({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "ferric-site" });
  });

  test("rejects non-GET methods", async () => {
    const res = await worker.fetch(new Request("https://ferric.smithers.sh/", { method: "POST" }), envWith({}));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });
});
