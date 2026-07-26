import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createKimiBenchmarksSiteWorker, type KimiBenchmarksSiteEnv } from "../src/worker.ts";

const homeHtml = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");

function makeEnv(): KimiBenchmarksSiteEnv {
  return {
    ASSETS: {
      async fetch(request: Request) {
        const url = new URL(request.url);
        if (url.pathname === "/" || url.pathname === "/index.html") {
          return new Response(homeHtml, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (url.pathname === "/evidence/reward.json") {
          return Response.json({
            reward: 1,
            phases_passed: 3,
            total_phases: 3,
          });
        }
        return new Response("not found", { status: 404 });
      },
    },
  };
}

describe("Kimi benchmarks site worker", () => {
  test("publishes the controlled comparison and scope warning", () => {
    expect(homeHtml).toContain("Kimi K3 <span>closes</span> the roadmap");
    expect(homeHtml).toContain("1.000");
    expect(homeHtml).toContain("0.714");
    expect(homeHtml).toContain("Do not rank these together");
    expect(homeHtml).toContain('href="evidence/reward.json"');
    expect(homeHtml).not.toContain("/Users/");
  });

  test("serves the report with cache and security headers", async () => {
    const response = await createKimiBenchmarksSiteWorker().fetch(
      new Request("https://kimibenchmarks.smithers.sh/"),
      makeEnv(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await response.text()).toContain("Kimi K3");
  });

  test("serves public artifacts with bounded caching", async () => {
    const response = await createKimiBenchmarksSiteWorker().fetch(
      new Request("https://kimibenchmarks.smithers.sh/evidence/reward.json"),
      makeEnv(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await response.json()).toEqual({
      reward: 1,
      phases_passed: 3,
      total_phases: 3,
    });
  });

  test("falls back to the report for presentation paths", async () => {
    const response = await createKimiBenchmarksSiteWorker().fetch(
      new Request("https://kimibenchmarks.smithers.sh/results"),
      makeEnv(),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Kimi K3");
  });

  test("reports health without touching static assets", async () => {
    const response = await createKimiBenchmarksSiteWorker().fetch(
      new Request("https://kimibenchmarks.smithers.sh/healthz"),
      makeEnv(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "kimi-benchmarks-site",
    });
  });

  test("rejects mutating methods", async () => {
    const response = await createKimiBenchmarksSiteWorker().fetch(
      new Request("https://kimibenchmarks.smithers.sh/", { method: "POST" }),
      makeEnv(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(await response.text()).toBe("method not allowed");
  });
});
