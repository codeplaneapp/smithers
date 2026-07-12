import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishWalkthrough, uploadWalkthrough } from "../../src/cli/publishWalkthrough";

const originalUrl = process.env.SMITHERS_REVIEW_PUBLISH_URL;
const originalToken = process.env.SMITHERS_REVIEW_PUBLISH_TOKEN;
const originalShareOrigin = process.env.SMITHERS_REVIEW_SHARE_ORIGIN;
const originalFetch = globalThis.fetch;
const dirs: string[] = [];

beforeEach(() => {
  delete process.env.SMITHERS_REVIEW_PUBLISH_URL;
  delete process.env.SMITHERS_REVIEW_PUBLISH_TOKEN;
  delete process.env.SMITHERS_REVIEW_SHARE_ORIGIN;
});

afterEach(() => {
  if (originalUrl === undefined) delete process.env.SMITHERS_REVIEW_PUBLISH_URL;
  else process.env.SMITHERS_REVIEW_PUBLISH_URL = originalUrl;
  if (originalToken === undefined) delete process.env.SMITHERS_REVIEW_PUBLISH_TOKEN;
  else process.env.SMITHERS_REVIEW_PUBLISH_TOKEN = originalToken;
  if (originalShareOrigin === undefined) delete process.env.SMITHERS_REVIEW_SHARE_ORIGIN;
  else process.env.SMITHERS_REVIEW_SHARE_ORIGIN = originalShareOrigin;
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
    mkdirSync(homeDir, { recursive: true });
    const configPath = join(homeDir, ".smithers-review.json");
    writeFileSync(
      configPath,
      JSON.stringify({ publishUrl: "https://share.test/", publishToken: "cfg-token" }),
    );
    chmodSync(configPath, 0o600);

    const seen: { url?: string; auth?: string; redirect?: string } = {};
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.url = String(url);
      seen.auth = (init.headers as Record<string, string>).authorization;
      seen.redirect = init.redirect;
      return new Response(JSON.stringify({ id: "abcde012345a", url: "https://share.test/w/abcde012345a" }), { status: 201 });
    }) as unknown as typeof fetch;

    const shareUrl = await publishWalkthrough(htmlPath, { homeDir });
    expect(shareUrl).toBe("https://share.test/w/abcde012345a");
    // Trailing slash on the configured URL is stripped before appending the path.
    expect(seen.url).toBe("https://share.test/api/walkthroughs");
    expect(seen.auth).toBe("Bearer cfg-token");
    expect(seen.redirect).toBe("error");
    void dir;
  });

  test("rejects a partial environment pair instead of mixing sources", async () => {
    const { homeDir, htmlPath } = tempSetup();
    mkdirSync(homeDir, { recursive: true });
    const configPath = join(homeDir, ".smithers-review.json");
    writeFileSync(configPath, JSON.stringify({
      publishUrl: "https://trusted.test",
      publishToken: "stored-token",
    }));
    chmodSync(configPath, 0o600);
    process.env.SMITHERS_REVIEW_PUBLISH_URL = "https://share.test";
    delete process.env.SMITHERS_REVIEW_PUBLISH_TOKEN;
    await expect(publishWalkthrough(htmlPath, { homeDir })).rejects.toThrow("must be set together");
  });

  test("throws with the HTTP status and body when the upload fails", async () => {
    const { htmlPath, homeDir } = tempSetup();
    process.env.SMITHERS_REVIEW_PUBLISH_URL = "https://share.test";
    process.env.SMITHERS_REVIEW_PUBLISH_TOKEN = "t";
    globalThis.fetch = (async () =>
      new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
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
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "abcde012345a" }), { status: 201 })) as unknown as typeof fetch;
    await expect(publishWalkthrough(htmlPath, { homeDir })).rejects.toThrow("response had no url");
  });

  test("binds response URLs to an explicitly configured share origin", async () => {
    const { htmlPath, homeDir } = tempSetup();
    process.env.SMITHERS_REVIEW_PUBLISH_URL = "https://share.test";
    process.env.SMITHERS_REVIEW_PUBLISH_TOKEN = "t";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: "abcde012345a",
      url: "https://public.test/w/abcde012345a",
    }), { status: 201 })) as unknown as typeof fetch;
    await expect(publishWalkthrough(htmlPath, { homeDir })).rejects.toThrow("not a canonical HTTPS walkthrough URL");

    process.env.SMITHERS_REVIEW_SHARE_ORIGIN = "https://public.test";
    await expect(publishWalkthrough(htmlPath, { homeDir })).resolves.toBe("https://public.test/w/abcde012345a");

    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: "abcde012345a",
      url: "https://public.test/w/different-id",
    }), { status: 201 })) as unknown as typeof fetch;
    await expect(publishWalkthrough(htmlPath, { homeDir })).rejects.toThrow("not a canonical HTTPS walkthrough URL");
  });

  test("supports an explicitly local HTTP publish and share service", async () => {
    const { htmlPath, homeDir } = tempSetup();
    process.env.SMITHERS_REVIEW_PUBLISH_URL = "http://127.0.0.1:43210";
    process.env.SMITHERS_REVIEW_PUBLISH_TOKEN = "t";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: "abcde012345a",
      url: "http://127.0.0.1:43210/w/abcde012345a",
    }), { status: 201 })) as unknown as typeof fetch;
    await expect(publishWalkthrough(htmlPath, { homeDir })).resolves.toBe(
      "http://127.0.0.1:43210/w/abcde012345a",
    );
  });

  test("rejects symlinked, oversized, non-private, and schema-smuggled config files", async () => {
    const { dir, homeDir, htmlPath } = tempSetup();
    delete process.env.SMITHERS_REVIEW_PUBLISH_URL;
    delete process.env.SMITHERS_REVIEW_PUBLISH_TOKEN;
    mkdirSync(homeDir, { recursive: true });
    const configPath = join(homeDir, ".smithers-review.json");
    const target = join(dir, "target.json");

    writeFileSync(target, JSON.stringify({ publishUrl: "https://share.test", publishToken: "secret" }));
    chmodSync(target, 0o600);
    symlinkSync(target, configPath);
    await expect(publishWalkthrough(htmlPath, { homeDir })).rejects.toThrow();
    rmSync(configPath);

    writeFileSync(configPath, "x".repeat(16 * 1024 + 1));
    chmodSync(configPath, 0o600);
    await expect(publishWalkthrough(htmlPath, { homeDir })).rejects.toThrow("16 KB");

    writeFileSync(configPath, JSON.stringify({
      publishUrl: "https://share.test",
      publishToken: "secret",
      redirectTokenTo: "https://attacker.invalid",
    }));
    chmodSync(configPath, 0o600);
    await expect(publishWalkthrough(htmlPath, { homeDir })).rejects.toThrow("unknown fields");

    if (process.platform !== "win32") {
      writeFileSync(configPath, JSON.stringify({ publishUrl: "https://share.test", publishToken: "secret" }));
      chmodSync(configPath, 0o644);
      await expect(publishWalkthrough(htmlPath, { homeDir })).rejects.toThrow("private");
    }
  });

  test("enforces a real deadline when an injected fetch ignores AbortSignal", async () => {
    const started = Date.now();
    await expect(uploadWalkthrough(
      new TextEncoder().encode("<html></html>"),
      "https://share.test",
      "token",
      {
        timeoutMs: 10,
        fetch: (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
      },
    )).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("rejects invalid UTF-8 in the private publish config", async () => {
    const { homeDir, htmlPath } = tempSetup();
    mkdirSync(homeDir, { recursive: true });
    const configPath = join(homeDir, ".smithers-review.json");
    writeFileSync(configPath, Uint8Array.from([0xff]), { mode: 0o600 });
    await expect(publishWalkthrough(htmlPath, { homeDir })).rejects.toThrow(/UTF-8/);
  });
});
