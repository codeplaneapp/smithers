import { describe, expect, test } from "bun:test";
import { GatewayRpcError, SmithersGatewayClient, SmithersGatewayConnection } from "../src/index.ts";

type SentRequest = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];

  readonly OPEN = 1;
  readonly CLOSED = 3;
  readonly url: string;
  readyState = this.OPEN;
  sent: string[] = [];
  closeCalls = 0;
  sendError: Error | undefined;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    if (this.sendError) {
      throw this.sendError;
    }
    this.sent.push(String(data));
  }

  close() {
    if (this.readyState === this.CLOSED) {
      return;
    }
    this.readyState = this.CLOSED;
    this.closeCalls += 1;
    this.dispatchEvent(new Event("close"));
  }

  open() {
    this.readyState = this.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(frame: unknown) {
    const data = typeof frame === "string" ? frame : JSON.stringify(frame);
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  lastRequest(): SentRequest {
    const raw = this.sent.at(-1);
    if (!raw) {
      throw new Error("FakeWebSocket has no sent request.");
    }
    return JSON.parse(raw) as SentRequest;
  }
}

function fakeWebSocketCtor() {
  FakeWebSocket.instances = [];
  return FakeWebSocket as unknown as typeof WebSocket;
}

function okResponse(payload: unknown, status = 200) {
  return Response.json({ type: "res", id: "http", ok: true, payload }, { status });
}

function errorResponse(error: Record<string, unknown>, status = 500) {
  return Response.json({ type: "res", id: "http", ok: false, error }, { status });
}

async function waitForSent(ws: FakeWebSocket, count: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (ws.sent.length >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${count} sent WebSocket frame(s).`);
}

describe("SmithersGatewayClient HTTP RPC", () => {
  test("normalizes base URLs and sends typed JSON RPC requests with auth headers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return okResponse({ runId: "run-1", workflow: "deploy" });
    };
    const client = new SmithersGatewayClient({
      baseUrl: "http://gateway.local///",
      token: "secret-token",
      headers: { "x-client": "test" },
      fetch: fetchImpl,
    });

    const result = await client.launchRun({ workflow: "deploy", input: { sha: "abc123" } });

    expect(result).toEqual({ runId: "run-1", workflow: "deploy" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://gateway.local/v1/rpc/launchRun");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      workflow: "deploy",
      input: { sha: "abc123" },
    });
    const headers = calls[0].init.headers as Headers;
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer secret-token");
    expect(headers.get("x-client")).toBe("test");
  });

  test("preserves gateway error details on failed RPC frames", async () => {
    const client = new SmithersGatewayClient({
      fetch: async () => errorResponse({
        code: "Forbidden",
        message: "Missing scope.",
        requiredScope: "run:write",
        refresh: "reauth",
        details: { scope: "run:write" },
      }, 403),
    });

    const failure = client.resumeRun({ runId: "run-1" }).catch((error) => error);

    await expect(failure).resolves.toBeInstanceOf(GatewayRpcError);
    await expect(failure).resolves.toMatchObject({
      name: "GatewayRpcError",
      method: "resumeRun",
      status: 403,
      code: "Forbidden",
      message: "Missing scope.",
      requiredScope: "run:write",
      refresh: "reauth",
      details: { scope: "run:write" },
    });
  });

  test("rejects malformed successful responses as invalid gateway frames", async () => {
    const client = new SmithersGatewayClient({
      fetch: async () => Response.json({ ok: true, payload: { runId: "run-1" } }),
    });

    await expect(client.getRun({ runId: "run-1" })).rejects.toMatchObject({
      name: "GatewayRpcError",
      method: "getRun",
      code: "INVALID_GATEWAY_RESPONSE",
      status: 200,
    });
  });

  test("rejects non-JSON successful responses as invalid gateway frames", async () => {
    const client = new SmithersGatewayClient({
      fetch: async () => new Response("not json", { status: 200 }),
    });

    await expect(client.getRun({ runId: "run-1" })).rejects.toMatchObject({
      name: "GatewayRpcError",
      method: "getRun",
      code: "INVALID_GATEWAY_RESPONSE",
      status: 200,
    });
  });

  test("maps non-frame HTTP failures to HTTP_ERROR", async () => {
    const client = new SmithersGatewayClient({
      fetch: async () => Response.json({ error: "bad gateway" }, { status: 502 }),
    });

    await expect(client.getRun({ runId: "run-1" })).rejects.toMatchObject({
      name: "GatewayRpcError",
      method: "getRun",
      code: "HTTP_ERROR",
      status: 502,
    });
  });

  test("covers all stable convenience RPC methods added around the gateway contract", async () => {
    const methods: string[] = [];
    const client = new SmithersGatewayClient({
      fetch: async (url) => {
        methods.push(String(url).split("/").at(-1) ?? "");
        return okResponse({});
      },
    });

    await client.hijackRun({ runId: "run-1" });
    await client.rewindRun({ runId: "run-1", frameNo: 1, confirm: true });
    await client.cancelRun({ runId: "run-1" });
    await client.submitApproval({ runId: "run-1", nodeId: "gate", decision: "approved" });
    await client.submitSignal({ runId: "run-1", signal: "continue", payload: {} });
    await client.listRuns();
    await client.listApprovals();
    await client.getNodeOutput({ runId: "run-1", nodeId: "task" });
    await client.getNodeDiff({ runId: "run-1", nodeId: "task" });
    await client.cronList();
    await client.cronCreate({ workflow: "deploy", pattern: "* * * * *" });
    await client.cronDelete({ cronId: "cron-1" });
    await client.cronRun({ workflow: "deploy", input: { manual: true } });

    expect(methods).toEqual([
      "hijackRun",
      "rewindRun",
      "cancelRun",
      "submitApproval",
      "submitSignal",
      "listRuns",
      "listApprovals",
      "getNodeOutput",
      "getNodeDiff",
      "cronList",
      "cronCreate",
      "cronDelete",
      "cronRun",
    ]);
  });
});

describe("SmithersGatewayConnection WebSocket RPC", () => {
  test("sends request frames and resolves matching response frames", async () => {
    const ws = new FakeWebSocket("ws://gateway.local");
    const connection = new SmithersGatewayConnection(ws as unknown as WebSocket);

    const pending = connection.requestRaw("connect", { minProtocol: 1 });
    const request = ws.lastRequest();

    expect(request).toMatchObject({
      type: "req",
      method: "connect",
      params: { minProtocol: 1 },
    });

    ws.receive({ type: "res", id: request.id, ok: true, payload: { sessionToken: "session-1" } });

    await expect(pending).resolves.toEqual({ sessionToken: "session-1" });
  });

  test("rejects matching response errors with GatewayRpcError", async () => {
    const ws = new FakeWebSocket("ws://gateway.local");
    const connection = new SmithersGatewayConnection(ws as unknown as WebSocket);

    const pending = connection.requestRaw("streamRunEvents", { runId: "run-1" });
    const request = ws.lastRequest();
    ws.receive({
      type: "res",
      id: request.id,
      ok: false,
      error: { code: "RunNotFound", message: "Run not found." },
    });

    await expect(pending).rejects.toMatchObject({
      name: "GatewayRpcError",
      method: "streamRunEvents",
      code: "RunNotFound",
      message: "Run not found.",
    });
  });

  test("removes failed sends from the pending map", async () => {
    const ws = new FakeWebSocket("ws://gateway.local");
    ws.sendError = new Error("socket buffer full");
    const connection = new SmithersGatewayConnection(ws as unknown as WebSocket);

    await expect(connection.requestRaw("connect", {})).rejects.toThrow("socket buffer full");
    expect(connection.pending.size).toBe(0);
  });

  test("rejects malformed WebSocket frames through the event stream", async () => {
    const ws = new FakeWebSocket("ws://gateway.local");
    const connection = new SmithersGatewayConnection(ws as unknown as WebSocket);
    const iterator = connection.events();

    const next = iterator.next();
    ws.receive("{not json");

    await expect(next).rejects.toMatchObject({
      name: "GatewayRpcError",
      code: "INVALID_GATEWAY_RESPONSE",
    });
    connection.close();
  });

  test("surfaces WebSocket error events through the event stream", async () => {
    const ws = new FakeWebSocket("ws://gateway.local");
    const connection = new SmithersGatewayConnection(ws as unknown as WebSocket);
    const next = connection.events().next();

    ws.dispatchEvent(new Event("error"));

    await expect(next).rejects.toThrow("Gateway WebSocket error");
    connection.close();
  });

  test("rejects pending requests when the connection closes", async () => {
    const ws = new FakeWebSocket("ws://gateway.local");
    const connection = new SmithersGatewayConnection(ws as unknown as WebSocket);

    const pending = connection.requestRaw("getRun", { runId: "run-1" });
    connection.close();

    await expect(pending).rejects.toThrow("Gateway WebSocket closed");
    expect(connection.pending.size).toBe(0);
    expect(ws.closeCalls).toBe(1);
  });
});

describe("SmithersGatewayClient WebSocket helpers", () => {
  test("performs the connect handshake with auth, client metadata, and subscribed runs", async () => {
    const WebSocket = fakeWebSocketCtor();
    const client = new SmithersGatewayClient({
      baseUrl: "https://gateway.local",
      token: "secret-token",
      WebSocket,
      client: { id: "client-1", version: "1.2.3", platform: "test" },
    });

    const pending = client.connect({ subscribe: ["run-1"] });
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe("wss://gateway.local/");
    ws.open();
    await waitForSent(ws, 1);

    const request = ws.lastRequest();
    expect(request).toMatchObject({
      type: "req",
      method: "connect",
      params: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "client-1", version: "1.2.3", platform: "test" },
        auth: { token: "secret-token" },
        subscribe: ["run-1"],
      },
    });
    ws.receive({ type: "res", id: request.id, ok: true, payload: { sessionToken: "session-1" } });

    const connection = await pending;
    expect(connection).toBeInstanceOf(SmithersGatewayConnection);
    connection.close();
  });

  test("closes the socket when the connect handshake is rejected", async () => {
    const WebSocket = fakeWebSocketCtor();
    const client = new SmithersGatewayClient({ WebSocket });

    const pending = client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    await waitForSent(ws, 1);
    const request = ws.lastRequest();
    ws.receive({
      type: "res",
      id: request.id,
      ok: false,
      error: { code: "Unauthorized", message: "Bad token." },
    });

    await expect(pending).rejects.toMatchObject({
      name: "GatewayRpcError",
      method: "connect",
      code: "Unauthorized",
    });
    expect(ws.closeCalls).toBe(1);
  });

  test("rejects when WebSocket open fails", async () => {
    const WebSocket = fakeWebSocketCtor();
    const client = new SmithersGatewayClient({ WebSocket });

    const pending = client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.dispatchEvent(new Event("error"));

    await expect(pending).rejects.toThrow("Gateway WebSocket failed to open");
    expect(ws.closeCalls).toBe(1);
  });

  test("aborts a pending WebSocket open and closes the socket", async () => {
    const WebSocket = fakeWebSocketCtor();
    const controller = new AbortController();
    const client = new SmithersGatewayClient({ WebSocket });

    const pending = client.connect({ signal: controller.signal });
    const ws = FakeWebSocket.instances[0];
    controller.abort();

    await expect(pending).rejects.toThrow("Gateway WebSocket open aborted");
    expect(ws.closeCalls).toBe(1);
  });

  test("filters run stream events by stream id and closes after iterator return", async () => {
    const WebSocket = fakeWebSocketCtor();
    const client = new SmithersGatewayClient({ WebSocket });

    const iterator = client.streamRunEvents({ runId: "run-1" });
    const next = iterator.next();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    await waitForSent(ws, 1);
    ws.receive({ type: "res", id: ws.lastRequest().id, ok: true, payload: {} });
    await waitForSent(ws, 2);
    ws.receive({
      type: "res",
      id: ws.lastRequest().id,
      ok: true,
      payload: { streamId: "stream-1", runId: "run-1", afterSeq: null, currentSeq: 0 },
    });

    ws.receive({
      type: "event",
      event: "run.event",
      seq: 1,
      stateVersion: 1,
      payload: { streamId: "other", runId: "run-1" },
    });
    ws.receive({
      type: "event",
      event: "run.event",
      seq: 2,
      stateVersion: 1,
      payload: { streamId: "stream-1", runId: "run-1", event: "task.completed" },
    });

    await expect(next).resolves.toMatchObject({
      done: false,
      value: {
        event: "run.event",
        seq: 2,
        payload: { streamId: "stream-1", runId: "run-1", event: "task.completed" },
      },
    });

    await iterator.return(undefined);
    expect(ws.closeCalls).toBe(1);
  });

  test("streams DevTools frames through the same typed helper pattern as run events", async () => {
    const WebSocket = fakeWebSocketCtor();
    const client = new SmithersGatewayClient({ WebSocket });

    const iterator = client.streamDevTools({ runId: "run-1", afterSeq: 2 });
    const next = iterator.next();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    await waitForSent(ws, 1);
    ws.receive({ type: "res", id: ws.lastRequest().id, ok: true, payload: {} });
    await waitForSent(ws, 2);
    ws.receive({
      type: "res",
      id: ws.lastRequest().id,
      ok: true,
      payload: { streamId: "devtools-1", runId: "run-1", afterSeq: 2 },
    });

    ws.receive({
      type: "event",
      event: "devtools.event",
      seq: 1,
      stateVersion: 1,
      payload: { streamId: "other", runId: "run-1", event: { kind: "snapshot" } },
    });
    ws.receive({
      type: "event",
      event: "devtools.event",
      seq: 2,
      stateVersion: 1,
      payload: { streamId: "devtools-1", runId: "run-1", event: { kind: "delta" } },
    });

    await expect(next).resolves.toMatchObject({
      done: false,
      value: {
        event: "devtools.event",
        seq: 2,
        payload: { streamId: "devtools-1", runId: "run-1", event: { kind: "delta" } },
      },
    });

    await iterator.return(undefined);
    expect(ws.closeCalls).toBe(1);
  });
});
