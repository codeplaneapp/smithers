import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AnthropicAgent, createHttpTool } from "../src/index.js";
import { createHttpTool as createHttpToolFromFacade } from "smithers-orchestrator";

/** AI SDK passes these to `execute`; the HTTP tool ignores them. */
const callOptions = { toolCallId: "test-call", messages: [] };

let server;
let baseUrl;
let attackerServer;
let attackerUrl;

/** @param {Request} request */
async function echoRequest(request) {
  const url = new URL(request.url);
  const bodyText = await request.text();
  return Response.json(
    {
      method: request.method,
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      authorization: request.headers.get("authorization"),
      apiKey: request.headers.get("x-api-key"),
      body: bodyText ? JSON.parse(bodyText) : null,
    },
    { status: 201, headers: { "x-test-response": "ok" } },
  );
}

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: echoRequest });
  baseUrl = `http://${server.hostname}:${server.port}`;
  attackerServer = Bun.serve({ port: 0, fetch: echoRequest });
  attackerUrl = `http://${attackerServer.hostname}:${attackerServer.port}`;
});

afterAll(() => {
  server?.stop(true);
  attackerServer?.stop(true);
});

describe("createHttpTool", () => {
  test("is exported from the documented smithers-orchestrator facade", () => {
    expect(createHttpToolFromFacade).toBe(createHttpTool);
    expect(typeof createHttpToolFromFacade().execute).toBe("function");
  });

  test("creates an agent-callable REST escape hatch", async () => {
    const http = createHttpTool();

    expect(typeof http.execute).toBe("function");

    const result = await http.execute(
      {
        method: "POST",
        url: `${baseUrl}/v1/messages`,
        query: { cursor: "abc", limit: 10 },
        headers: { "x-api-key": "secret" },
        auth: { type: "bearer", token: "token-123" },
        body: { text: "hello" },
      },
      callOptions,
    );

    expect(result).toMatchObject({
      ok: true,
      status: 201,
      statusText: "Created",
      body: {
        method: "POST",
        pathname: "/v1/messages",
        query: { cursor: "abc", limit: "10" },
        authorization: "Bearer token-123",
        apiKey: "secret",
        body: { text: "hello" },
      },
    });
    expect(result.headers["x-test-response"]).toBe("ok");
  });

  test("sends configured secret default headers only to allowlisted hosts", async () => {
    const http = createHttpTool({
      baseUrl,
      defaultHeaders: { authorization: "Bearer configured-secret" },
    });

    const toBase = await http.execute({ url: `${baseUrl}/data` }, callOptions);
    expect(toBase.body.authorization).toBe("Bearer configured-secret");

    const toAttacker = await http.execute({ url: `${attackerUrl}/steal` }, callOptions);
    expect(toAttacker.body.authorization).toBeNull();
  });

  test("allowedHosts pins secret default headers to explicit extra hosts", async () => {
    const attackerHost = new URL(attackerUrl).host;
    const http = createHttpTool({
      baseUrl,
      allowedHosts: [attackerHost],
      defaultHeaders: { "x-api-key": "configured-secret" },
    });

    const toAllowed = await http.execute({ url: `${attackerUrl}/ok` }, callOptions);
    expect(toAllowed.body.apiKey).toBe("configured-secret");
  });

  test("without an allowlist default headers keep going everywhere (unchanged)", async () => {
    const http = createHttpTool({ defaultHeaders: { "x-api-key": "shared" } });

    const toBase = await http.execute({ url: `${baseUrl}/a` }, callOptions);
    const toAttacker = await http.execute({ url: `${attackerUrl}/b` }, callOptions);
    expect(toBase.body.apiKey).toBe("shared");
    expect(toAttacker.body.apiKey).toBe("shared");
  });

  test("mounts onto an SDK agent toolset", () => {
    const agent = new AnthropicAgent({
      id: "http-agent",
      model: fakeModel(),
      tools: { http: createHttpTool() },
    });
    expect(agent).toBeDefined();
  });

  test("rejects an oversized declared response length before reading the body", async () => {
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-length": "11" } },
      );
    try {
      await expect(
        createHttpTool({ maxResponseBytes: 10 }).execute(
          { url: `${baseUrl}/large` },
          callOptions,
        ),
      ).rejects.toThrow("exceeds the 10-byte limit");
      expect(cancelled).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("cancels a chunked response that exceeds the configured limit", async () => {
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("12345"));
            controller.enqueue(new TextEncoder().encode("6"));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    try {
      await expect(
        createHttpTool({ maxResponseBytes: 5 }).execute(
          { url: `${baseUrl}/chunked` },
          callOptions,
        ),
      ).rejects.toThrow("exceeds the 5-byte limit");
      expect(cancelled).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps body-less responses that declare an oversized Content-Length (HEAD)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(null, { headers: { "content-length": "999999999" } });
    try {
      const result = await createHttpTool({ maxResponseBytes: 10 }).execute(
        { method: "HEAD", url: `${baseUrl}/large` },
        callOptions,
      );
      expect(result.ok).toBe(true);
      expect(result.body).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("accepts a response exactly at the configured limit and preserves JSON parsing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('{"ok":true}', {
        headers: { "content-type": "application/json", "content-length": "11" },
      });
    try {
      const result = await createHttpTool({ maxResponseBytes: 11 }).execute(
        { url: `${baseUrl}/exact` },
        callOptions,
      );
      expect(result.body).toEqual({ ok: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/** A prebuilt language model so constructing the agent needs no API key. */
function fakeModel() {
  return {
    specificationVersion: "v3",
    provider: "test-provider",
    modelId: "fake-model",
    get supportedUrls() {
      return {};
    },
    async doGenerate() {
      return {
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error("stream not implemented in test");
    },
  };
}
