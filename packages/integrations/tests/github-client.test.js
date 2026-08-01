import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { setSmithersLogRunner } from "@smithers-orchestrator/observability/logging";
import { makeGitHubClient, nextPageUrl } from "../src/github/GitHubClient.js";
import { configureGitHub, resolveGitHubConfig } from "../src/github/config.js";

/**
 * Real HTTP fixture speaking the GitHub REST wire format (no mocks): create
 * comment/issue/PR/labels/status endpoints record every request; dedicated
 * paths exercise 429 → success, 403 secondary-rate-limit → success, and
 * Link-header pagination.
 */
function startFixture() {
  /** @type {{ method: string; path: string; headers: Record<string, string>; body: any }[]} */
  const requests = [];
  let rateLimited429 = 0;
  let rateLimited403 = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = request.method === "GET" ? null : await request.json().catch(() => null);
      /** @type {Record<string, string>} */
      const headers = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });
      requests.push({ method: request.method, path: url.pathname, headers, body });
      const json = (/** @type {unknown} */ payload, init = {}) =>
        new Response(JSON.stringify(payload), {
          ...init,
          headers: { "content-type": "application/json", .../** @type {any} */ (init).headers },
        });
      if (url.pathname === "/repos/acme/app/issues/7/comments" && request.method === "POST") {
        return json(
          { id: 42, html_url: "https://github.com/acme/app/issues/7#issuecomment-42", body: body?.body },
          { status: 201 },
        );
      }
      if (url.pathname === "/repos/acme/app/issues" && request.method === "POST") {
        return json(
          { number: 101, html_url: "https://github.com/acme/app/issues/101", title: body?.title },
          { status: 201 },
        );
      }
      if (url.pathname === "/repos/acme/app/pulls" && request.method === "POST") {
        return json({ number: 55, html_url: "https://github.com/acme/app/pull/55" }, { status: 201 });
      }
      if (url.pathname === "/repos/acme/app/issues/7/labels" && request.method === "POST") {
        return json((body?.labels ?? []).map((/** @type {string} */ name) => ({ name })));
      }
      if (url.pathname.startsWith("/repos/acme/app/statuses/") && request.method === "POST") {
        return json({ state: body?.state, url: `https://api.github.com${url.pathname}` }, { status: 201 });
      }
      if (url.pathname === "/rate-limited-429") {
        if (rateLimited429 < 2) {
          rateLimited429 += 1;
          return json(
            { message: "API rate limit exceeded" },
            {
              status: 429,
              headers: { "retry-after": "0" },
            },
          );
        }
        return json({ ok: true, path: "429" });
      }
      if (url.pathname === "/rate-limited-403") {
        if (rateLimited403 < 1) {
          rateLimited403 += 1;
          return json(
            { message: "You have exceeded a secondary rate limit. Please wait." },
            {
              status: 403,
              headers: { "retry-after": "0", "x-ratelimit-remaining": "12" },
            },
          );
        }
        return json({ ok: true, path: "403" });
      }
      if (url.pathname.startsWith("/retry-after-")) {
        return json(
          { message: "API rate limit exceeded" },
          {
            status: 429,
            headers: { "retry-after": "1" },
          },
        );
      }
      if (url.pathname === "/foreign-paged") {
        const next = url.searchParams.get("next");
        return json([1], { headers: next ? { link: `<${next}>; rel="next"` } : {} });
      }
      if (url.pathname === "/paged") {
        const page = Number(url.searchParams.get("page") ?? "1");
        const items = page === 1 ? [1, 2] : page === 2 ? [3] : [];
        const next =
          page < 2
            ? `<${url.origin}/paged?per_page=2&page=${page + 1}>; rel="next", <${url.origin}/paged?per_page=2&page=2>; rel="last"`
            : null;
        return json(items, { headers: next ? { link: next } : {} });
      }
      return json({ message: "Not Found" }, { status: 404 });
    },
  });
  return { server, requests, url: `http://127.0.0.1:${server.port}` };
}

/**
 * A second real server on a different origin: any request landing here from
 * the client under test would mean the repository token escaped its API
 * origin.
 */
function startForeignFixture() {
  /** @type {{ path: string; headers: Record<string, string> }[]} */
  const requests = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      /** @type {Record<string, string>} */
      const headers = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });
      requests.push({ path: new URL(request.url).pathname, headers });
      return new Response(JSON.stringify([99]), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { server, requests, url: `http://127.0.0.1:${server.port}` };
}

const fixture = startFixture();
const foreign = startForeignFixture();
const client = makeGitHubClient({
  token: "test-token-shhh",
  apiBaseUrl: fixture.url,
});

/**
 * Wait for the real HTTP fixture to observe the expected number of requests.
 * The timeout uses the host timer because retry sleeps run on Effect's virtual
 * TestClock in the focused retry tests below.
 * @param {string} path
 * @param {number} count
 */
async function waitForRequestCount(path, count) {
  const deadline = Date.now() + 2_000;
  while (fixture.requests.filter((request) => request.path === path).length < count) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${count} request(s) to ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settleHostTasks = () => new Promise((resolve) => setTimeout(resolve, 20));

afterAll(() => {
  fixture.server.stop(true);
  foreign.server.stop(true);
  configureGitHub(null);
});

describe("resolveGitHubConfig", () => {
  test("explicit wins over registry, registry over env, defaults applied", () => {
    configureGitHub({ token: "registry-token", apiBaseUrl: "http://registry" });
    expect(resolveGitHubConfig().token).toBe("registry-token");
    expect(resolveGitHubConfig({ token: "explicit" }).token).toBe("explicit");
    expect(resolveGitHubConfig({ apiBaseUrl: undefined }).apiBaseUrl).toBe("http://registry");
    configureGitHub(null);
    expect(resolveGitHubConfig().apiBaseUrl).toBe("https://api.github.com");
    expect(resolveGitHubConfig().maxRetries).toBe(3);
  });
});

describe("GitHubClient", () => {
  test("POSTs with bearer token + GitHub media type and returns parsed JSON", async () => {
    const response = await Effect.runPromise(
      client.request("POST", "/repos/acme/app/issues/7/comments", { body: "hi" }),
    );
    expect(response).toMatchObject({ id: 42, body: "hi" });
    const recorded = fixture.requests.find((r) => r.path === "/repos/acme/app/issues/7/comments");
    expect(recorded?.headers.authorization).toBe("Bearer test-token-shhh");
    expect(recorded?.headers.accept).toBe("application/vnd.github+json");
    expect(recorded?.headers["x-github-api-version"]).toBe("2022-11-28");
    expect(recorded?.body).toEqual({ body: "hi" });
  });
  test("retries 429 honoring Retry-After until success", async () => {
    const response = await Effect.runPromise(client.request("GET", "/rate-limited-429"));
    expect(response).toEqual({ ok: true, path: "429" });
    expect(fixture.requests.filter((r) => r.path === "/rate-limited-429")).toHaveLength(3);
  });
  test("retries 403 secondary-rate-limit responses", async () => {
    const response = await Effect.runPromise(client.request("GET", "/rate-limited-403"));
    expect(response).toEqual({ ok: true, path: "403" });
    expect(fixture.requests.filter((r) => r.path === "/rate-limited-403")).toHaveLength(2);
  });
  test("does not delay or log when retries are disabled", async () => {
    const path = "/retry-after-disabled";
    const retryDisabledClient = makeGitHubClient({
      token: "test-token-shhh",
      apiBaseUrl: fixture.url,
      maxRetries: 0,
    });
    let retryLogs = 0;
    const restoreLogger = setSmithersLogRunner({
      runFork() {
        retryLogs += 1;
      },
      async runPromise() {},
    });
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(retryDisabledClient.request("GET", path));
          yield* Effect.promise(() => waitForRequestCount(path, 1));
          yield* Effect.promise(settleHostTasks);
          const exit = fiber.pollUnsafe();
          yield* Fiber.interrupt(fiber);
          return { exit };
        }).pipe(Effect.provide(TestClock.layer())),
      );
      expect(fixture.requests.filter((request) => request.path === path)).toHaveLength(1);
      expect(result.exit).toBeDefined();
      expect(retryLogs).toBe(0);
    } finally {
      restoreLogger();
    }
  });
  test("delays and logs once between attempts without a trailing delay", async () => {
    const path = "/retry-after-exhausted";
    const retryOnceClient = makeGitHubClient({
      token: "test-token-shhh",
      apiBaseUrl: fixture.url,
      maxRetries: 1,
    });
    let retryLogs = 0;
    const restoreLogger = setSmithersLogRunner({
      runFork() {
        retryLogs += 1;
      },
      async runPromise() {},
    });
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(retryOnceClient.request("GET", path));
          yield* Effect.promise(() => waitForRequestCount(path, 1));
          yield* Effect.promise(settleHostTasks);
          const exitBeforeRetry = fiber.pollUnsafe();
          yield* TestClock.adjust("1250 millis");
          yield* Effect.promise(() => waitForRequestCount(path, 2));
          yield* Effect.promise(settleHostTasks);
          const exit = fiber.pollUnsafe();
          yield* Fiber.interrupt(fiber);
          return { exitBeforeRetry, exit };
        }).pipe(Effect.provide(TestClock.layer())),
      );
      expect(fixture.requests.filter((request) => request.path === path)).toHaveLength(2);
      expect(result.exitBeforeRetry).toBeUndefined();
      expect(result.exit).toBeDefined();
      expect(retryLogs).toBe(1);
    } finally {
      restoreLogger();
    }
  });
  test("does not retry 404 and never leaks the token into the error", async () => {
    const before = fixture.requests.length;
    const error = await Effect.runPromise(client.request("GET", "/repos/acme/app/nope").pipe(Effect.flip));
    expect(fixture.requests.length).toBe(before + 1);
    expect(error.details?.status).toBe(404);
    const serialized = JSON.stringify({ message: error.message, details: error.details });
    expect(serialized).not.toContain("test-token-shhh");
  });
  test("paginate follows Link rel=next headers", async () => {
    const items = await Effect.runPromise(client.paginate("/paged", { perPage: 2 }));
    expect(items).toEqual([1, 2, 3]);
  });
  test("rejects direct foreign absolute URLs without contacting them", async () => {
    const error = await Effect.runPromise(client.request("GET", `${foreign.url}/steal`).pipe(Effect.flip));
    expect(error.message).toContain("not the configured GitHub API origin");
    expect(error.details?.retryable).toBe(false);
    expect(foreign.requests).toHaveLength(0);
  });
  test("rejects foreign pagination links without leaking the token", async () => {
    const error = await Effect.runPromise(
      client.paginate(`/foreign-paged?next=${encodeURIComponent(`${foreign.url}/paged`)}`).pipe(Effect.flip),
    );
    expect(error.message).toContain("not the configured GitHub API origin");
    expect(foreign.requests).toHaveLength(0);
  });
  test("accepts same-origin absolute URLs and pagination links", async () => {
    const items = await Effect.runPromise(client.paginate(`${fixture.url}/paged`, { perPage: 2 }));
    expect(items).toEqual([1, 2, 3]);
  });
});

describe("nextPageUrl", () => {
  test("parses rel=next and ignores other rels", () => {
    expect(nextPageUrl('<https://x/paged?page=2>; rel="next", <https://x/paged?page=9>; rel="last"')).toBe(
      "https://x/paged?page=2",
    );
    expect(nextPageUrl('<https://x/paged?page=9>; rel="last"')).toBeNull();
    expect(nextPageUrl(null)).toBeNull();
  });
});
