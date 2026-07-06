import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SmithersGatewayClient } from "../src/index.ts";

class FakeWebSocket extends EventTarget {
  static urls: string[] = [];
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = this.CONNECTING;

  constructor(url: string | URL) {
    super();
    FakeWebSocket.urls.push(String(url));
    queueMicrotask(() => {
      this.readyState = this.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(raw: string) {
    const frame = JSON.parse(raw) as { id: string };
    queueMicrotask(() => {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { protocol: 1 },
          }),
        }),
      );
    });
  }

  close() {
    this.readyState = this.CLOSED;
    this.dispatchEvent(new CloseEvent("close"));
  }
}

describe("SmithersGatewayClient", () => {
  test("calls stable Gateway HTTP RPCs", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new SmithersGatewayClient({
      baseUrl: "http://gateway.test/",
      fetch: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({
            type: "res",
            id: "http",
            ok: true,
            payload: [{ key: "deploy", hasUi: true, uiPath: "/workflows/deploy" }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    });

    await expect(client.listWorkflows({ filter: { hasUi: true } })).resolves.toEqual([
      { key: "deploy", hasUi: true, uiPath: "/workflows/deploy" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://gateway.test/v1/rpc/listWorkflows");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.body).toBe(JSON.stringify({ filter: { hasUi: true } }));
    expect(new Headers(calls[0].init.headers).get("content-type")).toBe("application/json");
  });

  test("preserves ws+unix socket paths when opening WebSocket connections", async () => {
    FakeWebSocket.urls = [];
    globalThis.__SMITHERS_GATEWAY_UI__ = {
      apiVersion: "v1",
      kind: "gateway",
      workflowKey: null,
      mountPath: "/console",
      rpcPath: "/v1/rpc",
      wsPath: "/rpc",
      assetBasePath: "/console/__smithers_ui",
      props: {},
    };
    try {
      const client = new SmithersGatewayClient({
        baseUrl: "ws+unix:///tmp/smithers-gateway.sock:/",
        WebSocket: FakeWebSocket as unknown as typeof WebSocket,
      });

      const connection = await client.connect();
      connection.close();

      expect(FakeWebSocket.urls).toEqual(["ws+unix:///tmp/smithers-gateway.sock:/rpc"]);
    } finally {
      globalThis.__SMITHERS_GATEWAY_UI__ = undefined;
    }
  });
});

describe("default client version", () => {
  test("tracks package.json so the connect handshake can't report a stale release", () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "../package.json"), "utf8"),
    ) as { version: string };
    const client = new SmithersGatewayClient();
    expect(client.client.version).toBe(pkg.version);
  });
});
