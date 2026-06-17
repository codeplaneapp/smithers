import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AnthropicAgent, createHttpTool } from "../src/index.js";
import { createHttpTool as createHttpToolFromFacade } from "smithers-orchestrator";

/** AI SDK passes these to `execute`; the HTTP tool ignores them. */
const callOptions = { toolCallId: "test-call", messages: [] };

let server;
let baseUrl;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
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
    },
  });
  baseUrl = `http://${server.hostname}:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
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

  test("mounts onto an SDK agent toolset", () => {
    const agent = new AnthropicAgent({
      id: "http-agent",
      model: fakeModel(),
      tools: { http: createHttpTool() },
    });
    expect(agent).toBeDefined();
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
