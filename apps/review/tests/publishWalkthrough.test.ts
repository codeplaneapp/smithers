import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const originalPublishUrl = process.env.SMITHERS_REVIEW_PUBLISH_URL;
const originalPublishToken = process.env.SMITHERS_REVIEW_PUBLISH_TOKEN;
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalPublishUrl === undefined) delete process.env.SMITHERS_REVIEW_PUBLISH_URL;
  else process.env.SMITHERS_REVIEW_PUBLISH_URL = originalPublishUrl;
  if (originalPublishToken === undefined) delete process.env.SMITHERS_REVIEW_PUBLISH_TOKEN;
  else process.env.SMITHERS_REVIEW_PUBLISH_TOKEN = originalPublishToken;
  globalThis.fetch = originalFetch;
});

describe("publishWalkthrough", () => {
  test("requires an explicit publish URL instead of using a default host", async () => {
    const { publishWalkthrough } = await import("../src/cli/publishWalkthrough");
    const dir = mkdtempSync(join("/tmp", "review-publish-"));
    const homeDir = join(dir, "home");
    const htmlPath = join(dir, "walkthrough.html");
    writeFileSync(htmlPath, "<!doctype html><html><body>walkthrough</body></html>");
    delete process.env.SMITHERS_REVIEW_PUBLISH_URL;
    process.env.SMITHERS_REVIEW_PUBLISH_TOKEN = "test-token";

    let fetchCalled = false;
    globalThis.fetch = (() => {
      fetchCalled = true;
      return Promise.resolve(new Response(JSON.stringify({ url: "https://example.test/w/abc" }), { status: 201 }));
    }) as unknown as typeof fetch;

    try {
      await expect(publishWalkthrough(htmlPath, { homeDir })).rejects.toThrow("no publish URL");
      expect(fetchCalled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
