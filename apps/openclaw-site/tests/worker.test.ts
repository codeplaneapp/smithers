import { describe, expect, test } from "bun:test";
import { createOpenClawSiteWorker, type OpenClawSiteEnv } from "../src/worker.ts";

function makeEnv(): OpenClawSiteEnv {
  return {
    ASSETS: {
      async fetch(request: Request) {
        const url = new URL(request.url);
        if (url.pathname === "/" || url.pathname === "/index.html") {
          return new Response("<!doctype html><title>OpenClaw</title>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (url.pathname === "/assets/openclaw-hero.jpg") {
          return new Response("jpeg", {
            headers: { "content-type": "image/jpeg" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    },
  };
}

describe("OpenClaw site worker", () => {
  test("serves the marketing home page", async () => {
    const response = await createOpenClawSiteWorker().fetch(new Request("https://openclaw.smithers.sh/"), makeEnv());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.text()).toContain("OpenClaw");
  });

  test("serves immutable image assets", async () => {
    const response = await createOpenClawSiteWorker().fetch(
      new Request("https://openclaw.smithers.sh/assets/openclaw-hero.jpg"),
      makeEnv(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("falls back to the home page for marketing paths", async () => {
    const response = await createOpenClawSiteWorker().fetch(
      new Request("https://openclaw.smithers.sh/workflows"),
      makeEnv(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("OpenClaw");
  });

  test("reports health without touching static assets", async () => {
    const response = await createOpenClawSiteWorker().fetch(new Request("https://openclaw.smithers.sh/healthz"), makeEnv());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "openclaw-site" });
  });
});
