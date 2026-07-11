import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { createOpenApiToolSync } from "../src/tool-factory/createOpenApiToolSync.js";
import { executeRequest } from "../src/tool-factory/_helpers.js";

const callOptions = { toolCallId: "security-test", messages: [] };
const originalFetch = globalThis.fetch;

let api;
let crossOrigin;
let apiUrl;
let crossOriginUrl;

const specFor = (baseUrl, path = "/resource") => ({
  openapi: "3.1.0",
  info: { title: "outbound safety", version: "1" },
  servers: [{ url: baseUrl }],
  paths: {
    [path]: {
      get: {
        operationId: "readResource",
        responses: { 200: { description: "ok" } },
      },
    },
  },
});

beforeAll(() => {
  crossOrigin = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/bounce") {
        return new Response(null, { status: 302, headers: { location: `${apiUrl}/target` } });
      }
      return Response.json({ authorization: request.headers.get("authorization") });
    },
  });
  crossOriginUrl = `http://127.0.0.1:${crossOrigin.port}`;

  api = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/same-origin") {
        return new Response(null, { status: 302, headers: { location: "/target" } });
      }
      if (url.pathname === "/cross-origin") {
        return new Response(null, { status: 302, headers: { location: `${crossOriginUrl}/target` } });
      }
      if (url.pathname === "/multi-origin") {
        return new Response(null, { status: 302, headers: { location: `${crossOriginUrl}/bounce` } });
      }
      if (url.pathname === "/declared-oversize") {
        return new Response("12345", { headers: { "content-length": "5", "content-type": "text/plain" } });
      }
      if (url.pathname === "/exact-cap") {
        return new Response("1234", { headers: { "content-type": "text/plain" } });
      }
      if (url.pathname === "/chunked-oversize") {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("123"));
            controller.enqueue(new TextEncoder().encode("45"));
            controller.close();
          },
        }), { headers: { "content-type": "text/plain" } });
      }
      if (url.pathname === "/pending") {
        await new Promise((resolve) => request.signal.addEventListener("abort", resolve, { once: true }));
        return new Response("aborted");
      }
      if (url.pathname === "/echo-error") {
        const authorization = request.headers.get("authorization");
        let decodedBasic = null;
        if (authorization?.startsWith("Basic ")) {
          decodedBasic = atob(authorization.slice("Basic ".length));
        }
        return Response.json({
          ordinary: "ordinary-context-survives",
          authorization,
          decodedBasic,
          headerApiKey: request.headers.get("x-auth-key"),
          staticHeader: request.headers.get("x-static-secret"),
          requestUrl: request.url,
          queryApiKey: url.searchParams.get("api_key"),
        }, { status: 403, statusText: "Forbidden" });
      }
      if (url.pathname === "/echo-success") {
        return Response.json({
          ordinary: "ordinary-success",
          echo: request.headers.get("x-static-secret"),
        });
      }
      if (url.pathname === "/malformed-error") {
        return new Response(`{"echo":"${request.headers.get("authorization")}`, {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json({ authorization: request.headers.get("authorization") });
    },
  });
  apiUrl = `http://127.0.0.1:${api.port}`;
});

afterAll(() => {
  api?.stop(true);
  crossOrigin?.stop(true);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenAPI outbound HTTP policy", () => {
  test("returns a typed tool error for non-HTTP server schemes before fetch", async () => {
    for (const baseUrl of [
      "file:///tmp/secrets",
      "data:text/plain,secret",
      "ftp://example.com/private",
    ]) {
      const tool = createOpenApiToolSync(specFor(baseUrl), "readResource");
      await expect(tool.execute({}, callOptions)).resolves.toMatchObject({
        error: true,
        status: "failed",
        message: expect.stringContaining("Only HTTP(S)"),
      });
    }
  });

  test("keeps configured auth on same-origin redirects", async () => {
    const tool = createOpenApiToolSync(specFor(apiUrl, "/same-origin"), "readResource", {
      baseUrl: apiUrl,
      auth: { type: "bearer", token: "same-origin-secret" },
    });
    const result = await tool.execute({}, callOptions);
    expect(result.authorization).toBe("Bearer same-origin-secret");
  });

  test("strips configured auth on an unauthorized cross-origin redirect", async () => {
    const tool = createOpenApiToolSync(specFor(apiUrl, "/cross-origin"), "readResource", {
      baseUrl: apiUrl,
      auth: { type: "bearer", token: "must-not-leak" },
      allowPrivateNetwork: true,
    });
    const result = await tool.execute({}, callOptions);
    expect(result.authorization).toBeNull();
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  test("retains auth only when the redirect origin is explicitly authorized", async () => {
    const tool = createOpenApiToolSync(specFor(apiUrl, "/cross-origin"), "readResource", {
      baseUrl: apiUrl,
      auth: { type: "bearer", token: "authorized-secret" },
      allowedOrigins: [crossOriginUrl],
      allowPrivateNetwork: true,
    });
    const result = await tool.execute({}, callOptions);
    expect(result.authorization).toBe("Bearer authorized-secret");
  });

  test("never reintroduces auth after an unauthorized hop returns to the API origin", async () => {
    const tool = createOpenApiToolSync(specFor(apiUrl, "/multi-origin"), "readResource", {
      baseUrl: apiUrl,
      auth: { type: "bearer", token: "multi-hop-secret" },
      allowPrivateNetwork: true,
    });
    const result = await tool.execute({}, callOptions);
    expect(result.authorization).toBeNull();
    expect(JSON.stringify(result)).not.toContain("multi-hop-secret");
  });

  test("bounds declared and streamed response bodies while accepting the exact cap", async () => {
    const oversized = createOpenApiToolSync(specFor(apiUrl, "/declared-oversize"), "readResource", {
      baseUrl: apiUrl,
      maxResponseBytes: 4,
    });
    await expect(oversized.execute({}, callOptions)).resolves.toMatchObject({ error: true, status: "failed" });

    const chunked = createOpenApiToolSync(specFor(apiUrl, "/chunked-oversize"), "readResource", {
      baseUrl: apiUrl,
      maxResponseBytes: 4,
    });
    await expect(chunked.execute({}, callOptions)).resolves.toMatchObject({ error: true, status: "failed" });

    const exact = createOpenApiToolSync(specFor(apiUrl, "/exact-cap"), "readResource", {
      baseUrl: apiUrl,
      maxResponseBytes: 4,
    });
    await expect(exact.execute({}, callOptions)).resolves.toBe("1234");
  });

  test("propagates AI SDK cancellation through Effect into fetch", async () => {
    const tool = createOpenApiToolSync(specFor(apiUrl, "/pending"), "readResource", {
      baseUrl: apiUrl,
    });
    const controller = new AbortController();
    const pending = tool.execute({}, { ...callOptions, abortSignal: controller.signal });
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("never trusts a spec-controlled initial server with operator credentials", async () => {
    let contacted = 0;
    const attacker = Bun.serve({
      port: 0,
      fetch: () => {
        contacted += 1;
        return Response.json({ stolen: true });
      },
    });
    try {
      const attackerUrl = `http://127.0.0.1:${attacker.port}`;
      const tool = createOpenApiToolSync(specFor(attackerUrl), "readResource", {
        auth: { type: "bearer", token: "must-not-leak" },
      });
      await expect(tool.execute({}, callOptions)).resolves.toMatchObject({
        error: true,
        status: "failed",
        message: expect.stringContaining("explicit baseUrl"),
      });
      expect(contacted).toBe(0);
    } finally {
      attacker.stop(true);
    }
  });

  test.each([
    ["terminal-dot localhost", "http://localhost./"],
    ["terminal-dot localhost subdomain", "http://service.localhost./"],
    ["single-label mDNS", "http://local./"],
    ["terminal-dot mDNS", "http://service.local./"],
    ["private IP literal", "http://127.0.0.1/"],
  ])("rejects a spec-controlled %s initial destination before fetch", async (_label, serverUrl) => {
    const fetchSpy = mock(async () => Response.json({ contacted: true }));
    globalThis.fetch = fetchSpy;
    const tool = createOpenApiToolSync(specFor(serverUrl), "readResource");

    await expect(tool.execute({}, callOptions)).resolves.toMatchObject({
      error: true,
      status: "failed",
      message: expect.stringContaining("ordinary public-unicast space"),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  test("allowPrivateNetwork explicitly opts a spec-controlled private destination in", async () => {
    const fetchSpy = mock(async () => Response.json({ contacted: true }));
    globalThis.fetch = fetchSpy;
    const tool = createOpenApiToolSync(specFor("http://127.0.0.1/"), "readResource", {
      allowPrivateNetwork: true,
    });

    await expect(tool.execute({}, callOptions)).resolves.toEqual({ contacted: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("blocks a public spec server from redirecting into a private destination", async () => {
    const contacted = [];
    const fetchSpy = mock(async (input) => {
      const url = String(input);
      contacted.push(url);
      if (url === "https://attacker.example/resource") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/latest/meta-data" },
        });
      }
      return Response.json({ private: true });
    });
    globalThis.fetch = fetchSpy;
    const tool = createOpenApiToolSync(
      specFor("https://attacker.example"),
      "readResource",
      { resolveHostname: async () => ["8.8.8.8"] },
    );

    await expect(tool.execute({}, callOptions)).resolves.toMatchObject({
      error: true,
      status: "failed",
      message: expect.stringContaining("ordinary public-unicast space"),
    });
    expect(contacted).toEqual(["https://attacker.example/resource"]);
  });

  test("blocks a spec server hostname whose DNS answers include a private address", async () => {
    const fetchSpy = mock(async () => Response.json({ private: true }));
    globalThis.fetch = fetchSpy;
    const tool = createOpenApiToolSync(
      specFor("https://public-alias.example"),
      "readResource",
      { resolveHostname: async () => ["8.8.8.8", "127.0.0.1"] },
    );

    await expect(tool.execute({}, callOptions)).resolves.toMatchObject({
      error: true,
      status: "failed",
      message: expect.stringContaining("resolves outside"),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  test("redacts every configured credential form from a hostile non-2xx echo", async () => {
    const cases = [
      {
        options: {
          auth: { type: "bearer", token: "bearer-secret-token" },
          headers: { "X-Static-Secret": "static-header-secret" },
        },
        forbidden: ["bearer-secret-token", "static-header-secret"],
      },
      {
        options: {
          auth: { type: "basic", username: "operator", password: "basic-password-secret" },
        },
        forbidden: [
          "basic-password-secret",
          btoa("operator:basic-password-secret"),
        ],
      },
      {
        options: {
          auth: { type: "apiKey", name: "X-Auth-Key", value: "header-api-secret", in: "header" },
        },
        forbidden: ["header-api-secret"],
      },
      {
        options: {
          auth: { type: "apiKey", name: "api_key", value: "query secret+/%", in: "query" },
        },
        forbidden: [
          "query secret+/%",
          "query+secret%2B%2F%25",
        ],
      },
    ];

    for (const { options, forbidden } of cases) {
      const tool = createOpenApiToolSync(specFor(apiUrl, "/echo-error"), "readResource", {
        baseUrl: apiUrl,
        ...options,
      });
      const result = await tool.execute({}, callOptions);
      const serialized = JSON.stringify(result);
      expect(result).toMatchObject({ error: true, status: "failed" });
      expect(serialized).toContain("ordinary-context-survives");
      expect(serialized).toContain("[REDACTED]");
      for (const secret of forbidden) expect(serialized).not.toContain(secret);
    }
  });

  test("does not redact successful payloads", async () => {
    const tool = createOpenApiToolSync(specFor(apiUrl, "/echo-success"), "readResource", {
      baseUrl: apiUrl,
      headers: { "X-Static-Secret": "success-payload-value" },
    });

    await expect(tool.execute({}, callOptions)).resolves.toEqual({
      ordinary: "ordinary-success",
      echo: "success-payload-value",
    });
  });

  test("redacts the structured error body and malformed JSON error text", async () => {
    /** @type {import("../src/ParsedOperation.ts").ParsedOperation} */
    const operation = {
      operationId: "readResource",
      method: "get",
      path: "/echo-error",
      summary: "",
      description: "",
      parameters: [],
      deprecated: false,
    };
    let caught;
    try {
      await executeRequest(operation, {}, apiUrl, {
        baseUrl: apiUrl,
        auth: { type: "bearer", token: "body-secret-token" },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.body).toMatchObject({ ordinary: "ordinary-context-survives" });
    expect(JSON.stringify(caught.body)).toContain("[REDACTED]");
    expect(JSON.stringify(caught.body)).not.toContain("body-secret-token");

    const malformed = createOpenApiToolSync(
      specFor(apiUrl, "/malformed-error"),
      "readResource",
      {
        baseUrl: apiUrl,
        auth: { type: "bearer", token: "malformed-secret-token" },
      },
    );
    const result = await malformed.execute({}, callOptions);
    expect(result).toMatchObject({ error: true, status: "failed" });
    expect(result.message).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain("malformed-secret-token");
  });
});
