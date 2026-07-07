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
  globalThis.fetch = /** @type {any} */ (async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  });
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
      { url: "https://api.example.com/x", method: "POST", body: { hello: "world" }, auth: { type: "bearer", token: "tok" } },
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
      { url: "https://api.example.com/x", method: "PUT", body: "raw-string", auth: { type: "basic", username: "u", password: "p" } },
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
      { url: "https://api.example.com/x", headers: { "x-req": "1" }, auth: { type: "header", name: "x-key", value: "kv" } },
      callOptions,
    );
    expect(calls[0].init.headers.get("x-key")).toBe("kv");
    expect(calls[0].init.headers.get("x-req")).toBe("1");
    expect(result.body).toBeNull(); // empty text -> null
  });

  test("fires the abort when the request outlives its timeout", async () => {
    let aborted = false;
    stub(async (_url, init) => {
      await new Promise((r) => setTimeout(r, 40));
      aborted = init.signal?.aborted ?? false;
      return Response.json({ late: true });
    });
    const tool = createHttpTool();
    const result = await tool.execute({ url: "https://api.example.com/slow", timeoutMs: 1 }, callOptions);
    expect(aborted).toBe(true);
    expect(result.body).toEqual({ late: true });
  });

  test("tolerates an unparseable baseUrl when resolving the allowlist", async () => {
    stub(() => Response.json({ ok: true }));
    const tool = createHttpTool({ baseUrl: "::::not a url", defaultHeaders: { "x-secret": "s" } });
    const result = await tool.execute({ url: "https://api.example.com/x" }, callOptions);
    expect(result.ok).toBe(true);
  });
});
