import { describe, expect, test } from "bun:test";

import { createSmithersDataClient } from "../../src/data/createSmithersDataClient.ts";

/**
 * Custom headers (an API key, a proxy's auth header) configured on the gateway
 * client must reach the collection API and the change stream, not just RPC —
 * otherwise a deployment that authorizes with a header sees its REST calls and
 * SSE stream rejected while RPC works.
 */
type Capture = { url: string; headers: Headers };

async function waitFor(predicate: () => boolean, timeoutMs = 3_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A fetch that records every request and answers envelopes or an SSE body. */
function capturingFetch(calls: Capture[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    if (String(url).includes("/v1/api/stream")) {
      // A live-but-silent event stream: enough to prove the request headers
      // without racing a reconnect.
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify({ ok: true, data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("createSmithersDataClient custom headers", () => {
  test("merges custom headers with content type and bearer auth on GET and mutating API requests", async () => {
    const calls: Capture[] = [];
    const client = createSmithersDataClient({
      mode: { kind: "local", apiBaseUrl: "http://gateway.test/", token: "tok" },
      headers: { "x-api-key": "key-1", "x-tenant": "acme" },
      fetch: capturingFetch(calls),
    });

    await client.api.listRuns();
    await client.api.submitSignal({ runId: "r1", signal: "go" } as never);

    const read = calls.find((call) => call.url.includes("/v1/api/runs"))!;
    expect(read.headers.get("x-api-key")).toBe("key-1");
    expect(read.headers.get("x-tenant")).toBe("acme");
    expect(read.headers.get("authorization")).toBe("Bearer tok");
    // A bodyless GET stays free of a content type.
    expect(read.headers.get("content-type")).toBeNull();

    const write = calls.find((call) => call.url.includes("/v1/api/signals"))!;
    expect(write.headers.get("x-api-key")).toBe("key-1");
    expect(write.headers.get("authorization")).toBe("Bearer tok");
    expect(write.headers.get("content-type")).toBe("application/json");
    client.close();
  });

  test("the workspace token overrides a conflicting custom authorization header", async () => {
    const calls: Capture[] = [];
    const client = createSmithersDataClient({
      mode: { kind: "local", apiBaseUrl: "http://gateway.test/", token: "tok" },
      headers: { authorization: "Bearer stale", "content-type": "text/plain" },
      fetch: capturingFetch(calls),
    });
    await client.api.listRuns();
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer tok");
    client.close();
  });

  test("custom headers with no token still ride along", async () => {
    const calls: Capture[] = [];
    const client = createSmithersDataClient({
      mode: { kind: "local", apiBaseUrl: "http://gateway.test/" },
      headers: { "x-api-key": "key-1" },
      fetch: capturingFetch(calls),
    });
    await client.api.listRuns();
    expect(calls[0]!.headers.get("x-api-key")).toBe("key-1");
    expect(calls[0]!.headers.get("authorization")).toBeNull();
    client.close();
  });

  test("the fetch-based SSE stream request carries the same headers", async () => {
    const calls: Capture[] = [];
    const client = createSmithersDataClient({
      mode: { kind: "local", apiBaseUrl: "http://gateway.test/", token: "tok" },
      headers: { "x-api-key": "key-1" },
      fetch: capturingFetch(calls),
    });
    const unsubscribe = client.stream.subscribe(() => {});
    await waitFor(() => calls.some((call) => call.url.includes("/v1/api/stream")));
    const stream = calls.find((call) => call.url.includes("/v1/api/stream"))!;
    expect(stream.headers.get("x-api-key")).toBe("key-1");
    expect(stream.headers.get("authorization")).toBe("Bearer tok");
    unsubscribe();
    client.close();
  });

  test("an injected EventSource receives the same headers in its init", async () => {
    const inits: Array<Record<string, string> | undefined> = [];
    class FakeEventSource {
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor(public url: string, init?: EventSourceInit & { headers?: Record<string, string> }) {
        inits.push(init?.headers);
        queueMicrotask(() => this.onopen?.(new Event("open")));
      }
      addEventListener() {}
      close() {}
    }

    const client = createSmithersDataClient({
      mode: { kind: "local", apiBaseUrl: "http://gateway.test/", token: "tok" },
      headers: { "x-api-key": "key-1" },
      EventSource: FakeEventSource as unknown as NonNullable<Parameters<typeof createSmithersDataClient>[0]["EventSource"]>,
    });
    const unsubscribe = client.stream.subscribe(() => {});
    await waitFor(() => inits.length > 0);
    expect(inits[0]!["x-api-key"]).toBe("key-1");
    expect(inits[0]!.authorization).toBe("Bearer tok");
    unsubscribe();
    client.close();
  });
});
