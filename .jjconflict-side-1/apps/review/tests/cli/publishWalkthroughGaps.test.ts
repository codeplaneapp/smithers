import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishWalkthrough } from "../../src/cli/publishWalkthrough.ts";

const originalUrl = process.env.SMITHERS_REVIEW_PUBLISH_URL;
const originalToken = process.env.SMITHERS_REVIEW_PUBLISH_TOKEN;
const originalFetch = globalThis.fetch;
const dirs: string[] = [];

afterEach(() => {
  if (originalUrl === undefined) delete process.env.SMITHERS_REVIEW_PUBLISH_URL;
  else process.env.SMITHERS_REVIEW_PUBLISH_URL = originalUrl;
  if (originalToken === undefined) delete process.env.SMITHERS_REVIEW_PUBLISH_TOKEN;
  else process.env.SMITHERS_REVIEW_PUBLISH_TOKEN = originalToken;
  globalThis.fetch = originalFetch;
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempSetup() {
  const dir = mkdtempSync(join(tmpdir(), "review-publish-gap-"));
  dirs.push(dir);
  const homeDir = join(dir, "home");
  writeFileSync(join(dir, "walkthrough.html"), "<!doctype html><body>w</body>");
  return { dir, homeDir, htmlPath: join(dir, "walkthrough.html") };
}

describe("publishWalkthrough config + upload", () => {
  test("reads URL and token from ~/.smithers-review.json when env is unset, then uploads", async () => {
    const { dir, homeDir, htmlPath } = tempSetup();
    delete process.env.SMITHERS_REVIEW_PUBLISH_URL;
    delete process.env.SMITHERS_REVIEW_PUBLISH_TOKEN;
    require("node:fs").mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(homeDir, ".smithers-review.json"),
      JSON.stringify({ publishUrl: "https://share.test/", publishToken: "cfg-token" }),
    );

    const seen: { url?: string; auth?: string } = {};
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.url = String(url);
      seen.auth = (init.headers as Record<string, string>).authorization;
      return new Response(JSON.stringify({ url: "https://share.test/w/xyz" }), { status: 201 });
    }) as unknown as typeof fetch;

    const shareUrl = await publishWalkthrough(htmlPath, { homeDir });
    expect(shareUrl).toBe("https://share.test/w/xyz");
    // Trailing slash on the configured URL is stripped before appending the path.
    expect(seen.url).toBe("https://share.test/api/walkthroughs");
    expect(seen.auth).toBe("Bearer cfg-token");
    void dir;
  });

  test("throws when a token is missing everywhere", async () => {
    const { homeDir, htmlPath } = tempSetup();
    process.env.SMITHERS_REVIEW_PUBLISH_URL = "https://share.test";
    delete process.env.SMITHERS_REVIEW_PUBLISH_TOKEN;
    // homeDir has no config file → no token available.
    await expect(publishWalkthrough(htmlPath, { homeDir })).rejects.toThrow("no publish token");
  });

  test("throws with the HTTP status and body when the upload fails", async () => {
    const { htmlPath, homeDir } = tempSetup();
    process.env.SMITHERS_REVIEW_PUBLISH_URL = "https://share.test";
    process.env.SMITHERS_REVIEW_PUBLISH_TOKEN = "t";
    globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    await expect(publishWalkthrough(htmlPath, { homeDir })).rejects.toThrow("publish failed: HTTP 429 rate limited");
  });

  test("swallows a failing response body read and still reports the HTTP status", async () => {
    const { htmlPath, homeDir } = tempSetup();
    process.env.SMITHERS_REVIEW_PUBLISH_URL = "https://share.test";
    process.env.SMITHERS_REVIEW_PUBLISH_TOKEN = "t";
    // A response whose .text() rejects → the `.catch(() => "")` guard yields "".
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error("stream broke")),
    })) as unknown as typeof fetch;
    await expect(publishWalkthrough(htmlPath, { homeDir })).rejects.toThrow("publish failed: HTTP 500");
  });

  test("throws when the success response omits a url", async () => {
    const { htmlPath, homeDir } = tempSetup();
    process.env.SMITHERS_REVIEW_PUBLISH_URL = "https://share.test";
    process.env.SMITHERS_REVIEW_PUBLISH_TOKEN = "t";
    globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 201 })) as unknown as typeof fetch;
    await expect(publishWalkthrough(htmlPath, { homeDir })).rejects.toThrow("response had no url");
  });
});
