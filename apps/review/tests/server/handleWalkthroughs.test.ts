import { describe, expect, test } from "bun:test";
import { createReviewWorker } from "../../src/server/worker.ts";
import { buildTestEnv } from "./helpers/buildTestEnv.ts";

function makeWorker() {
  return createReviewWorker({
    jwksUrl: "http://unused",
    anthropicBaseUrl: "http://unused",
    fetchUpstream: fetch,
    now: () => Date.now(),
    waitUntil: () => undefined,
  });
}

describe("walkthrough publish and serve", () => {
  test("publishes HTML to R2 and serves it from the returned /w/id URL", async () => {
    const env = await buildTestEnv({ PUBLIC_BASE_URL: "https://review.example" });
    const worker = makeWorker();
    const html = "<!doctype html><html><body><h1>Walkthrough</h1></body></html>";

    const publish = await worker.fetch(
      new Request("https://worker.test/api/walkthroughs", {
        method: "POST",
        headers: {
          authorization: "Bearer test-publish",
          "content-type": "text/html; charset=utf-8",
        },
        body: html,
      }),
      env,
    );

    expect(publish.status).toBe(201);
    const body = (await publish.json()) as { id: string; url: string };
    expect(body.id).toMatch(/^[a-z0-9]{12}$/);
    expect(body.url).toBe(`https://review.example/w/${body.id}`);

    const served = await worker.fetch(new Request(body.url), env);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(served.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(served.headers.get("x-robots-tag")).toBe("noindex");
    expect(await served.text()).toBe(html);
  });

  test("returns 404 for a missing walkthrough id", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();

    const served = await worker.fetch(new Request("https://review.test/w/abc12345"), env);

    expect(served.status).toBe(404);
    expect(await served.text()).toBe("Not found");
  });
});
