import { describe, expect, test } from "bun:test";

import { createSmithersDataClient } from "../../src/data/createSmithersDataClient.ts";
import type { SmithersStreamEvent } from "../../src/data/SmithersStreamEvent.ts";

/**
 * The SSE change-stream is driven through a REAL streaming fetch: a genuine
 * `Response` whose body is a real `ReadableStream` emitting SSE bytes. The
 * client's real frame parser, seq tracking, reconnect, and waitForSeq logic run
 * end to end. No route data is fabricated beyond the transport bytes.
 */
const encoder = new TextEncoder();

async function waitFor(predicate: () => boolean, timeoutMs = 3_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A fetch returning a real event-stream Response; `emit` receives the controller. */
function streamingFetch(emit: (controller: ReadableStreamDefaultController<Uint8Array>) => void, status = 200): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    let ctrl: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        ctrl = controller;
        emit(controller);
      },
    });
    init?.signal?.addEventListener("abort", () => {
      try { ctrl.close(); } catch { /* already closed */ }
    });
    return new Response(status === 200 ? body : null, {
      status,
      headers: status === 200 ? { "content-type": "text/event-stream" } : {},
    });
  }) as unknown as typeof fetch;
}

describe("createSmithersDataClient change stream", () => {
  test("parses change/reset/heartbeat frames, tracks seq, and resolves waitForSeq", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const events: SmithersStreamEvent[] = [];
    const client = createSmithersDataClient({
      mode: { kind: "local", apiBaseUrl: "http://gateway.test/" },
      fetch: streamingFetch((c) => { controller = c; }),
    });

    const statuses: string[] = [];
    const unsubscribeStatus = client.stream.subscribeStatus(() => statuses.push(client.stream.status().status));
    const unsubscribe = client.stream.subscribe((event) => events.push(event));

    // Once the stream is online, push a heartbeat, then a change with collections.
    await waitFor(() => client.stream.status().status === "online");
    controller.enqueue(encoder.encode("event: heartbeat\ndata: {\"seq\":3}\n\n"));
    controller.enqueue(encoder.encode("event: change\ndata: {\"seq\":7,\"collections\":[\"runs\",42,\"crons\"]}\n\n"));

    await waitFor(() => events.some((event) => event.type === "change"));
    const change = events.find((event) => event.type === "change") as Extract<SmithersStreamEvent, { type: "change" }>;
    // Non-string collection entries are filtered out.
    expect(change.collections).toEqual(["runs", "crons"]);
    expect(change.seq).toBe(7);

    // waitForSeq resolves immediately for an already-seen seq, and pends then
    // resolves for a future seq delivered by a later frame.
    await client.stream.waitForSeq(7);
    const pending = client.stream.waitForSeq(9);
    controller.enqueue(encoder.encode("event: change\ndata: {\"seq\":9,\"collections\":[]}\n\n"));
    await pending;

    expect(statuses).toContain("connecting");
    expect(statuses).toContain("online");
    unsubscribe();
    unsubscribeStatus();
    client.close();
  });

  test("close() drains outstanding waitForSeq waiters instead of leaking them", async () => {
    const client = createSmithersDataClient({
      mode: { kind: "local", apiBaseUrl: "http://gateway.test/" },
      // Hold the stream open but never emit the awaited seq.
      fetch: streamingFetch(() => {}),
    });
    // The waiter opens the stream and pends; close() resolves outstanding waiters.
    let settled = false;
    const pending = client.stream.waitForSeq(999).then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    client.close();
    await pending;
    expect(settled).toBe(true);
  });

  test("a 401 stream response flips status to unauthorized without reconnecting", async () => {
    const client = createSmithersDataClient({
      mode: { kind: "local", apiBaseUrl: "http://gateway.test/", token: "bad" },
      fetch: streamingFetch(() => {}, 401),
    });
    const unsubscribe = client.stream.subscribe(() => {});
    await waitFor(() => client.stream.status().status === "unauthorized");
    expect(client.stream.status().status).toBe("unauthorized");
    unsubscribe();
    client.close();
  });

  test("a parked unauthorized stream reopens and resets after a successful REST call", async () => {
    let tokenValid = false;
    let streamRequests = 0;
    const client = createSmithersDataClient({
      mode: { kind: "local", apiBaseUrl: "http://gateway.test/", token: "granted-later" },
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        if (href.includes("/v1/api/stream")) {
          streamRequests += 1;
          if (!tokenValid) return new Response(null, { status: 401 });
          const body = new ReadableStream<Uint8Array>({ start() {} });
          init?.signal?.addEventListener("abort", () => {});
          return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        if (!tokenValid) {
          return new Response(JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED", message: "Invalid token" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true, data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    const events: SmithersStreamEvent[] = [];
    const unsubscribe = client.stream.subscribe((event) => events.push(event));
    await waitFor(() => client.stream.status().status === "unauthorized");
    expect(streamRequests).toBe(1);

    // A failing REST call must NOT unpark the stream: the token is still bad.
    await expect(client.api.listRuns()).rejects.toThrow("Invalid token");
    expect(streamRequests).toBe(1);
    expect(client.stream.status().status).toBe("unauthorized");

    // Once the gateway accepts the token, the next successful REST call
    // reopens the stream and the recovery open announces a reset so
    // subscribers resync everything missed while parked.
    tokenValid = true;
    await client.api.listRuns();
    await waitFor(() => client.stream.status().status === "online");
    expect(streamRequests).toBe(2);
    await waitFor(() => events.some((event) => event.type === "reset"));

    unsubscribe();
    client.close();
  });

  test("mutate() blocks on the returned seq until the SSE stream delivers it", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const client = createSmithersDataClient({
      mode: { kind: "local", apiBaseUrl: "http://gateway.test/" },
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        if (href.includes("/v1/api/stream")) {
          const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
          init?.signal?.addEventListener("abort", () => { try { controller.close(); } catch { /* closed */ } });
          return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        return new Response(JSON.stringify({ ok: true, data: { runId: "r1" }, seq: 4 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    // Open the stream first so the mutation's waitForSeq has a live transport.
    const unsubscribe = client.stream.subscribe(() => {});
    await waitFor(() => client.stream.status().status === "online");

    let resolved = false;
    const mutation = client.api.launchRun({ workflow: "value", input: {} } as never).then((result) => {
      resolved = true;
      return result;
    });
    // The mutation is parked on waitForSeq(4) until the stream advances lastSeq.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(resolved).toBe(false);
    controller.enqueue(encoder.encode("event: change\ndata: {\"seq\":4,\"collections\":[\"runs\"]}\n\n"));
    const result = await mutation;
    expect(result).toMatchObject({ data: { runId: "r1" }, seq: 4 });

    unsubscribe();
    client.close();
  });

  test("reports a thrown stream transport failure through onError", async () => {
    const errors: Array<{ reason: string }> = [];
    const client = createSmithersDataClient({
      mode: { kind: "local", apiBaseUrl: "http://gateway.test/" },
      onError: (error) => errors.push(error as { reason: string }),
      // The fetch itself rejects — the async transport body hits its catch.
      fetch: (async () => { throw new Error("connect refused"); }) as unknown as typeof fetch,
    });
    const unsubscribe = client.stream.subscribe(() => {});
    await waitFor(() => errors.some((error) => error.reason === "disconnected"));
    unsubscribe();
    client.close();
  });

  test("reconnects after a drop by re-requesting the stream once the backoff elapses", async () => {
    let streamRequests = 0;
    const client = createSmithersDataClient({
      mode: { kind: "local", apiBaseUrl: "http://gateway.test/" },
      fetch: streamingFetch((controller) => {
        streamRequests += 1;
        // Drop the connection immediately on every attempt.
        controller.close();
      }),
    });
    const unsubscribe = client.stream.subscribe(() => {});
    // The first request drops, backoff (>=250ms) elapses, then the reconnect
    // timer fires openStream again — a second /v1/api/stream request.
    await waitFor(() => streamRequests >= 2, 4_000);
    expect(streamRequests).toBeGreaterThanOrEqual(2);
    unsubscribe();
    client.close();
  });

  test("uses a provided EventSource implementation instead of the fetch transport", async () => {
    const instances: FakeEventSource[] = [];
    class FakeEventSource {
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      listeners = new Map<string, (event: MessageEvent) => void>();
      closed = false;
      constructor(public url: string) {
        instances.push(this);
        queueMicrotask(() => this.onopen?.(new Event("open")));
      }
      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        this.listeners.set(type, listener);
      }
      emit(type: string, data: string) {
        this.listeners.get(type)?.(new MessageEvent(type, { data }));
      }
      close() { this.closed = true; }
    }

    const client = createSmithersDataClient({
      mode: { kind: "local", apiBaseUrl: "http://gateway.test/" },
      EventSource: FakeEventSource as unknown as CreateSmithersDataClientEventSource,
    });
    const events: SmithersStreamEvent[] = [];
    const unsubscribe = client.stream.subscribe((event) => events.push(event));
    await waitFor(() => client.stream.status().status === "online");
    expect(instances).toHaveLength(1);
    expect(instances[0].url).toContain("/v1/api/stream");

    instances[0].emit("change", JSON.stringify({ seq: 2, collections: ["runs"] }));
    await waitFor(() => events.some((event) => event.type === "change"));

    unsubscribe();
    client.close();
    expect(instances[0].closed).toBe(true);
  });
});

// Local alias so the FakeEventSource cast reads clearly.
type CreateSmithersDataClientEventSource = NonNullable<
  Parameters<typeof createSmithersDataClient>[0]["EventSource"]
>;
