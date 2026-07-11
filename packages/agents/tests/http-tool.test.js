import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HttpClientPolicyError } from "@smithers-orchestrator/http-client";
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
  if (url.pathname === "/redirect-same") {
    return new Response(null, { status: 302, headers: { location: "/redirect-target" } });
  }
  if (url.pathname === "/redirect-cross") {
    return new Response(null, { status: 302, headers: { location: `${attackerUrl}/redirect-target` } });
  }
  if (url.pathname === "/redirect-cross-back") {
    return new Response(null, { status: 302, headers: { location: `${attackerUrl}/redirect-back` } });
  }
  if (url.pathname === "/redirect-back") {
    return new Response(null, { status: 302, headers: { location: `${baseUrl}/redirect-target` } });
  }
  if (url.pathname === "/declared-oversize") {
    return new Response("12345", { headers: { "content-length": "5" } });
  }
  if (url.pathname === "/chunked-oversize") {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("123"));
          controller.enqueue(new TextEncoder().encode("45"));
          controller.close();
        },
      }),
    );
  }
  if (url.pathname === "/exact-cap") {
    return new Response("1234");
  }
  if (url.pathname === "/pending") {
    await new Promise((resolve) => request.signal.addEventListener("abort", resolve, { once: true }));
    return new Response("aborted");
  }
  if (url.pathname === "/reflect-secrets") {
    const operatorSecret = request.headers.get("x-api-key") ?? "";
    const callerSecret = request.headers.get("authorization") ?? "";
    return new Response(JSON.stringify({
      echoed: operatorSecret,
      nested: { [operatorSecret]: callerSecret },
    }), {
      status: 200,
      statusText: `${operatorSecret} accepted`,
      headers: {
        "content-type": "application/json",
        "x-debug-credential": operatorSecret,
      },
    });
  }
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
    const http = createHttpTool({ allowPrivateNetwork: true });

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
        authorization: "[REDACTED]",
        apiKey: "[REDACTED]",
        body: { text: "hello" },
      },
    });
    expect(result.headers["x-test-response"]).toBe("ok");
  });

  test("sends configured secret default headers only to allowlisted hosts", async () => {
    const http = createHttpTool({
      baseUrl,
      defaultHeaders: { authorization: "Bearer configured-secret" },
      allowPrivateNetwork: true,
    });

    const toBase = await http.execute({ url: `${baseUrl}/data` }, callOptions);
    expect(toBase.body.authorization).toBe("[REDACTED]");

    const toAttacker = await http.execute({ url: `${attackerUrl}/steal` }, callOptions);
    expect(toAttacker.body.authorization).toBeNull();
  });

  test("redacts reflected request credentials from every model-visible response field", async () => {
    const http = createHttpTool({
      baseUrl,
      defaultHeaders: { "x-api-key": "operator-secret" },
      allowPrivateNetwork: true,
    });

    const result = await http.execute({
      url: `${baseUrl}/reflect-secrets`,
      auth: { type: "bearer", token: "caller-secret" },
    }, callOptions);
    const visible = JSON.stringify(result);
    expect(visible).toContain("[REDACTED]");
    expect(visible).not.toContain("operator-secret");
    expect(visible).not.toContain("caller-secret");
  });

  test("an HTTPS base origin never authorizes cleartext HTTP on the same host", async () => {
    const base = new URL(baseUrl);
    const http = createHttpTool({
      baseUrl: `https://${base.host}`,
      defaultHeaders: { authorization: "Bearer must-stay-on-https" },
      allowPrivateNetwork: true,
    });
    const result = await http.execute({ url: `${baseUrl}/cleartext` }, callOptions);
    expect(result.body.authorization).toBeNull();
    expect(JSON.stringify(result)).not.toContain("must-stay-on-https");
  });

  test("allowedHosts pins secret default headers to explicit extra hosts", async () => {
    const http = createHttpTool({
      baseUrl,
      allowedHosts: [attackerUrl],
      defaultHeaders: { "x-api-key": "configured-secret" },
    });

    const toAllowed = await http.execute({ url: `${attackerUrl}/ok` }, callOptions);
    expect(toAllowed.body.apiKey).toBe("[REDACTED]");
  });

  test("an HTTPS allowedHosts entry never authorizes cleartext HTTP", async () => {
    const attackerHost = new URL(attackerUrl).host;
    const http = createHttpTool({
      allowedHosts: [`https://${attackerHost}`],
      defaultHeaders: { authorization: "Bearer must-stay-on-https" },
      allowPrivateNetwork: true,
    });

    const result = await http.execute({ url: `${attackerUrl}/cleartext` }, callOptions);
    expect(result.body.authorization).toBeNull();
    expect(JSON.stringify(result)).not.toContain("must-stay-on-https");
  });

  test("fails closed when default headers have no destination gate", () => {
    expect(() => createHttpTool({
      defaultHeaders: { "x-api-key": "must-not-leak" },
      allowPrivateNetwork: true,
    })).toThrow(/defaultHeaders require baseUrl or allowedHosts/);
  });

  test("mounts onto an SDK agent toolset", () => {
    const agent = new AnthropicAgent({
      id: "http-agent",
      model: fakeModel(),
      tools: { http: createHttpTool() },
    });
    expect(agent).toBeDefined();
  });

  test("rejects non-HTTP URLs and untrusted non-global destinations before fetch", async () => {
    const http = createHttpTool();
    for (const url of [
      "file:///tmp/secrets",
      "data:text/plain,secret",
      "ftp://example.com/secret",
    ]) {
      let caught;
      try {
        await http.execute({ url }, callOptions);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(HttpClientPolicyError);
      expect(caught).toMatchObject({ code: "UNSUPPORTED_PROTOCOL" });
    }

    await expect(
      createHttpTool({ baseUrl }).execute({ url: `${baseUrl}/normal-http` }, callOptions),
    ).resolves.toMatchObject({ ok: true });

    for (const url of [
      `${baseUrl}/private`,
      "http://192.0.2.1/resource",
      "http://198.18.0.1/resource",
      "http://[2001:db8::1]/resource",
      "http://[ff02::1]/resource",
      "http://2130706433/resource",
      "http://0177.0.0.1/resource",
      "http://0x7f000001/resource",
      "http://localhost./resource",
      "http://service.localhost./resource",
      "http://local./resource",
      "http://service.local./resource",
    ]) {
      await expect(http.execute({ url }, callOptions)).rejects.toMatchObject({
        code: "INVALID_URL",
      });
    }
  });

  test("rejects DNS aliases whose answers include a private address before fetch", async () => {
    let fetchCalls = 0;
    const http = createHttpTool({
      resolveHostname: async (hostname) => {
        expect(hostname).toBe("public-alias.example");
        return ["8.8.8.8", "127.0.0.1"];
      },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return Response.json({ reached: true });
    };
    try {
      await expect(http.execute({ url: "https://public-alias.example/secret" }, callOptions))
        .rejects.toMatchObject({ code: "INVALID_URL", details: { reason: "dns-non-public-address" } });
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("preserves credentials on same-origin redirects and strips them cross-origin", async () => {
    const http = createHttpTool({ baseUrl, allowPrivateNetwork: true });
    const same = await http.execute(
      { url: `${baseUrl}/redirect-same`, auth: { type: "bearer", token: "same-secret" } },
      callOptions,
    );
    expect(same.body.authorization).toBe("[REDACTED]");

    const cross = await http.execute(
      { url: `${baseUrl}/redirect-cross`, auth: { type: "bearer", token: "cross-secret" } },
      callOptions,
    );
    expect(cross.body.authorization).toBeNull();
    expect(JSON.stringify(cross)).not.toContain("cross-secret");
  });

  test("never reintroduces credentials after an unauthorized redirect hop", async () => {
    const http = createHttpTool({ baseUrl, allowPrivateNetwork: true });
    const result = await http.execute(
      {
        url: `${baseUrl}/redirect-cross-back`,
        auth: { type: "bearer", token: "multi-hop-secret" },
      },
      callOptions,
    );
    expect(result.body.authorization).toBeNull();
    expect(JSON.stringify(result)).not.toContain("multi-hop-secret");
  });

  test("retains credentials for an explicitly authorized redirect origin", async () => {
    const http = createHttpTool({ baseUrl, allowedOrigins: [attackerUrl] });
    const result = await http.execute(
      { url: `${baseUrl}/redirect-cross`, auth: { type: "bearer", token: "allowed-secret" } },
      callOptions,
    );
    expect(result.body.authorization).toBe("[REDACTED]");
  });

  test("bounds declared and chunked bodies and accepts a body exactly at the cap", async () => {
    const http = createHttpTool({ baseUrl, maxResponseBytes: 4 });
    await expect(http.execute({ url: `${baseUrl}/declared-oversize` }, callOptions)).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
    await expect(http.execute({ url: `${baseUrl}/chunked-oversize` }, callOptions)).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
    await expect(http.execute({ url: `${baseUrl}/exact-cap` }, callOptions)).resolves.toMatchObject({
      body: "1234",
    });
  });

  test("composes AI SDK cancellation with the per-request timeout", async () => {
    const http = createHttpTool({ baseUrl });
    const controller = new AbortController();
    const pending = http.execute(
      { url: `${baseUrl}/pending`, timeoutMs: 30_000 },
      { ...callOptions, abortSignal: controller.signal },
    );
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
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
