import { afterEach, describe, expect, test } from "bun:test";
import { createHttpTool } from "../src/http/createHttpTool.js";

const callOptions = { toolCallId: "test-call", messages: [] };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** @param {(url: URL, init: RequestInit) => Response | Promise<Response>} handler */
function stub(handler) {
  /** @type {{ url: string; init: any }[]} */
  const calls = [];
  globalThis.fetch = /** @type {any} */ (
    async (url, init) => {
      calls.push({ url: String(url), init });
      return handler(url, init);
    }
  );
  return calls;
}

describe("createHttpTool", () => {
  test("applies query params, default headers (host-gated), and a timeout signal", async () => {
    const calls = stub((url, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ ok: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const tool = createHttpTool({
      defaultHeaders: { "x-secret": "s" },
      allowedHosts: ["https://api.example.com"],
    });
    const result = await tool.execute(
      { url: "https://api.example.com/path", query: { a: 1, b: null, c: "x" }, timeoutMs: 5000 },
      callOptions,
    );
    expect(result).toMatchObject({ ok: true, status: 200, body: { ok: 1 } });
    expect(calls[0].url).toBe("https://api.example.com/path?a=1&c=x");
    expect(calls[0].init.headers.get("x-secret")).toBe("s");
  });

  test("withholds default headers from a host outside the allowlist", async () => {
    const calls = stub(() => new Response("", { status: 204 }));
    const tool = createHttpTool({ baseUrl: "https://api.example.com", defaultHeaders: { "x-secret": "s" } });
    const result = await tool.execute({ url: "https://evil.example/steal" }, callOptions);
    expect(result.body).toBeNull(); // 204 -> null
    expect(calls[0].init.headers.get("x-secret")).toBeNull();
  });

  test("serializes a JSON body and applies bearer auth", async () => {
    const calls = stub(() => Response.json({ echoed: true }));
    const tool = createHttpTool();
    await tool.execute(
      {
        url: "https://api.example.com/x",
        method: "POST",
        body: { hello: "world" },
        auth: { type: "bearer", token: "tok" },
      },
      callOptions,
    );
    expect(calls[0].init.headers.get("authorization")).toBe("Bearer tok");
    expect(calls[0].init.headers.get("content-type")).toBe("application/json");
    expect(calls[0].init.body).toBe(JSON.stringify({ hello: "world" }));
  });

  test("passes a string body through untouched and applies basic auth", async () => {
    const calls = stub(() => new Response("plain", { status: 200, headers: { "content-type": "text/plain" } }));
    const tool = createHttpTool();
    const result = await tool.execute(
      {
        url: "https://api.example.com/x",
        method: "PUT",
        body: "raw-string",
        auth: { type: "basic", username: "u", password: "p" },
      },
      callOptions,
    );
    expect(calls[0].init.body).toBe("raw-string");
    expect(calls[0].init.headers.get("authorization")).toBe(`Basic ${btoa("u:p")}`);
    expect(result.body).toBe("plain"); // non-json content-type -> text
  });

  test("applies a custom header auth and returns null for an empty body", async () => {
    const calls = stub(() => new Response("", { status: 200 }));
    const tool = createHttpTool({ allowedHosts: ["api.example.com:8443"] });
    const result = await tool.execute(
      {
        url: "https://api.example.com/x",
        headers: { "x-req": "1" },
        auth: { type: "header", name: "x-key", value: "kv" },
      },
      callOptions,
    );
    expect(calls[0].init.headers.get("x-key")).toBe("kv");
    expect(calls[0].init.headers.get("x-req")).toBe("1");
    expect(result.body).toBeNull(); // empty text -> null
  });

  test("returns malformed JSON as text while preserving the HTTP response envelope", async () => {
    stub(
      () =>
        new Response("{bad", {
          status: 502,
          statusText: "Bad Gateway",
          headers: { "content-type": "application/json", "x-upstream": "gateway" },
        }),
    );
    const tool = createHttpTool();

    const result = await tool.execute({ url: "https://api.example.com/failure" }, callOptions);

    expect(result).toMatchObject({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      headers: { "content-type": "application/json", "x-upstream": "gateway" },
      body: "{bad",
    });
  });

  test("propagates the timeout abort when an injected fetch returns a late response", async () => {
    let aborted = false;
    stub(async (_url, init) => {
      await new Promise((r) => setTimeout(r, 40));
      aborted = init.signal?.aborted ?? false;
      return Response.json({ late: true });
    });
    const tool = createHttpTool();
    const error = await tool.execute({ url: "https://api.example.com/slow", timeoutMs: 1 }, callOptions).then(
      () => null,
      (cause) => cause,
    );
    expect(aborted).toBe(true);
    expect(error).toMatchObject({ name: "AbortError" });
  });

  test("parses a full-URL allowlist entry down to its host", async () => {
    const calls = stub(() => Response.json({ ok: 1 }));
    const tool = createHttpTool({
      defaultHeaders: { "x-secret": "s" },
      allowedHosts: ["https://api.example.com/ignored/path", "  HTTP://Other.Example  "],
    });
    await tool.execute({ url: "https://api.example.com/x" }, callOptions);
    expect(calls[0].init.headers.get("x-secret")).toBe("s");
  });

  test("rejects an invalid baseUrl before it can disable the default-header allowlist", () => {
    const calls = stub(() => Response.json({ receivedSecret: true }));
    expect(() => createHttpTool({ baseUrl: "::::not a url", defaultHeaders: { "x-secret": "s" } })).toThrow(
      "createHttpTool baseUrl must be a valid absolute HTTP(S) URL",
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects an invalid baseUrl even when allowedHosts are configured", () => {
    expect(() =>
      createHttpTool({
        baseUrl: "::::not a url",
        allowedHosts: ["api.example.com"],
        defaultHeaders: { "x-secret": "s" },
      }),
    ).toThrow("createHttpTool baseUrl must be a valid absolute HTTP(S) URL");
  });
});
