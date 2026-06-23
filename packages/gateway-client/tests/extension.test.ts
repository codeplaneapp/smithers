// Verifies the extension SDK surface on SmithersGatewayClient. We assert the
// wire shape (method names, envelopes) rather than reaching into the gateway,
// since the server-side dispatcher has its own tests.
import { describe, expect, test } from "bun:test";
import { SmithersGatewayClient } from "../src/index.ts";
import {
  GATEWAY_EXTENSION_METHOD_PREFIX,
  GATEWAY_EXTENSION_STREAM_EVENT,
  GATEWAY_EXTENSION_STREAM_ERROR,
  extensionMethodName,
  extensionStreamMethodName,
} from "../src/GatewayExtensionEnvelope.ts";

describe("extension method name helpers", () => {
  test("builds canonical method names", () => {
    expect(extensionMethodName("github", "issue")).toBe("ext.github.issue");
    expect(extensionStreamMethodName("logs", "tail")).toBe("ext.stream.logs.tail");
    expect(GATEWAY_EXTENSION_METHOD_PREFIX).toBe("ext.");
  });
});

describe("SmithersGatewayClient.extensionRpc", () => {
  test("posts to /v1/rpc/ext.<ns>.<key> with the params body", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const client = new SmithersGatewayClient({
      baseUrl: "http://gateway.test/",
      fetch: async (url, init = {}) => {
        calls.push({ url: String(url), body: String(init.body ?? "") });
        return new Response(
          JSON.stringify({
            type: "res",
            id: "x",
            ok: true,
            payload: { id: "42", status: "open" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const out = await client.extensionRpc<{ id: string; status: string }>(
      "github",
      "issue",
      { id: "42" },
    );
    expect(out).toEqual({ id: "42", status: "open" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://gateway.test/v1/rpc/ext.github.issue");
    expect(JSON.parse(calls[0].body)).toEqual({ id: "42" });
  });

  test("surfaces a gateway error frame as a GatewayRpcError", async () => {
    const client = new SmithersGatewayClient({
      baseUrl: "http://gateway.test/",
      fetch: async () =>
        new Response(
          JSON.stringify({
            type: "res",
            id: "x",
            ok: false,
            error: { code: "FORBIDDEN", message: "Missing scope" },
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    });
    await expect(client.extensionRpc("github", "issue", {})).rejects.toThrow(/Missing scope/);
  });
});

describe("streamExtension WebSocket subscription", () => {
  class FakeWebSocket extends EventTarget {
    static instances: FakeWebSocket[] = [];
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 3;
    readyState = this.CONNECTING;
    sent: Array<{ id: string; method: string; params?: unknown }> = [];

    constructor(url: string | URL) {
      super();
      FakeWebSocket.instances.push(this);
      // Reset for a fresh test.
      queueMicrotask(() => {
        this.readyState = this.OPEN;
        this.dispatchEvent(new Event("open"));
      });
    }

    send(raw: string) {
      const frame = JSON.parse(raw);
      this.sent.push(frame);
      // Auto-answer connect + subscribe handshakes.
      if (frame.method === "connect") {
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { protocol: 1 } }),
            }),
          ),
        );
        return;
      }
      if (frame.method === "ext.stream.logs.tail") {
        queueMicrotask(() => {
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "res",
                id: frame.id,
                ok: true,
                payload: {
                  streamId: "stream-abc",
                  namespace: "logs",
                  key: "tail",
                  initial: { line: "init-1" },
                },
              }),
            }),
          );
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "event",
                event: GATEWAY_EXTENSION_STREAM_EVENT,
                payload: {
                  streamId: "stream-abc",
                  namespace: "logs",
                  key: "tail",
                  payload: { line: "live-1" },
                },
                seq: 1,
                stateVersion: 1,
              }),
            }),
          );
          // A frame for an unrelated stream must be filtered out by the client.
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "event",
                event: GATEWAY_EXTENSION_STREAM_EVENT,
                payload: {
                  streamId: "stream-other",
                  namespace: "logs",
                  key: "tail",
                  payload: { line: "should-not-see" },
                },
                seq: 2,
                stateVersion: 2,
              }),
            }),
          );
          this.close();
        });
      }
    }

    close() {
      this.readyState = this.CLOSED;
      this.dispatchEvent(new CloseEvent("close"));
    }
  }

  /** Build a FakeWebSocket variant where `send` drives the subscribe handshake via a callback. */
  function makeClientWithWS(
    sendHandler: (ws: FakeWebSocket, frame: { id: string; method: string; params?: unknown }) => void,
  ) {
    class CustomWS extends FakeWebSocket {
      send(raw: string) {
        const frame = JSON.parse(raw);
        this.sent.push(frame);
        if (frame.method === "connect") {
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { protocol: 1 } }),
              }),
            ),
          );
          return;
        }
        sendHandler(this, frame);
      }
    }
    FakeWebSocket.instances = [];
    const client = new SmithersGatewayClient({
      baseUrl: "http://gateway.test/",
      WebSocket: CustomWS as unknown as typeof WebSocket,
    });
    return { client, instances: FakeWebSocket.instances };
  }

  test("yields initial + filtered live frames, drops unrelated streamIds", async () => {
    FakeWebSocket.instances = [];
    const client = new SmithersGatewayClient({
      baseUrl: "http://gateway.test/",
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    });
    const out: unknown[] = [];
    for await (const frame of client.streamExtension<{ line: string }>("logs", "tail")) {
      out.push(frame);
    }
    expect(out).toEqual([{ line: "init-1" }, { line: "live-1" }]);
    const subscribeFrame = FakeWebSocket.instances[0].sent.find((f) => f.method === "ext.stream.logs.tail");
    expect(subscribeFrame).toBeDefined();
  });

  test("mid-stream error-frame throws GatewayRpcError", async () => {
    const { client } = makeClientWithWS((ws, frame) => {
      if (frame.method === "ext.stream.logs.tail") {
        queueMicrotask(() => {
          // Successful subscribe response first.
          ws.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "res",
                id: frame.id,
                ok: true,
                payload: { streamId: "stream-err", namespace: "logs", key: "tail" },
              }),
            }),
          );
          // Then an error frame for the same stream.
          ws.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "event",
                event: GATEWAY_EXTENSION_STREAM_ERROR,
                payload: {
                  streamId: "stream-err",
                  error: { code: "STREAM_FAILED", message: "upstream broke" },
                },
                seq: 1,
                stateVersion: 1,
              }),
            }),
          );
        });
      }
    });

    const iter = client.streamExtension<{ line: string }>("logs", "tail");
    await expect(async () => {
      for await (const _ of iter) {
        // consume
      }
    }).toThrow(/upstream broke/);
  });

  test("AbortSignal aborts the stream mid-flight", async () => {
    const ac = new AbortController();
    const { client } = makeClientWithWS((ws, frame) => {
      if (frame.method === "ext.stream.logs.tail") {
        queueMicrotask(() => {
          ws.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "res",
                id: frame.id,
                ok: true,
                payload: { streamId: "stream-abort", namespace: "logs", key: "tail", initial: { line: "first" } },
              }),
            }),
          );
          // Emit a live frame then abort.
          ws.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "event",
                event: GATEWAY_EXTENSION_STREAM_EVENT,
                payload: { streamId: "stream-abort", namespace: "logs", key: "tail", payload: { line: "live" } },
                seq: 1,
                stateVersion: 1,
              }),
            }),
          );
        });
      }
    });

    const out: unknown[] = [];
    const iter = client.streamExtension<{ line: string }>("logs", "tail", {}, { signal: ac.signal });
    for await (const frame of iter) {
      out.push(frame);
      if (out.length === 1) {
        // Abort after receiving the initial frame.
        ac.abort();
      }
    }
    // Only the initial frame (or initial + first live) should be collected; the abort ends iteration.
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(ac.signal.aborted).toBe(true);
  });
});
