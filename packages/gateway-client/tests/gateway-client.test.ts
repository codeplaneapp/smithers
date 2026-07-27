import { describe, expect, test } from "bun:test";
import { listGatewayRpcMethods } from "@smithers-orchestrator/gateway/rpc";
import type { GatewayRpcMethod } from "@smithers-orchestrator/gateway-client/rpc";
import type { GatewayAsyncState } from "@smithers-orchestrator/gateway-react/GatewayAsyncState";
import type {
  GatewayComparisonScoreRow as ProtocolGatewayComparisonScoreRow,
  GatewayDocKind as ProtocolGatewayDocKind,
  GatewayMemoryFact,
  GatewayPrompt,
  GatewayScoreDetail as ProtocolGatewayScoreDetail,
  GatewayScoreRow as ProtocolGatewayScoreRow,
  GatewayTicketRow as ProtocolGatewayTicketRow,
  GetScoreDetailResponse,
  ListMemoryFactsResponse,
  ListPromptsResponse,
  ListScoresForRunsResponse,
  ListScoresResponse,
  ListTicketsResponse,
} from "@smithers-orchestrator/protocol/gateway-rpc";
import {
  GATEWAY_EVENT_BACKPRESSURE_CODE,
  GatewayRpcError,
  SmithersGatewayClient,
  SmithersGatewayConnection,
} from "../src/index.ts";
import type {
  GatewayComparisonScoreRow,
  GatewayDocKind,
  GatewayMemoryFactRow,
  GatewayPromptRow,
  GatewayScoreDetail,
  GatewayScoreRow,
  GatewayTicketRow,
  UsageReport,
} from "../src/index.ts";
import type { UsageReport as CanonicalUsageReport } from "@smithers-orchestrator/usage";
import type { GatewayRpcRequestMap, GatewayRpcResponseMap } from "../src/GatewayRpcTypeMap.ts";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;
type Expect<Value extends true> = Value;

type _CanonicalGatewayWireAssertions = [
  Expect<Equal<GatewayMemoryFactRow, GatewayMemoryFact>>,
  Expect<Equal<GatewayPromptRow, GatewayPrompt>>,
  Expect<Equal<GatewayScoreRow, ProtocolGatewayScoreRow>>,
  Expect<Equal<GatewayComparisonScoreRow, ProtocolGatewayComparisonScoreRow>>,
  Expect<Equal<GatewayScoreDetail, ProtocolGatewayScoreDetail>>,
  Expect<Equal<GatewayDocKind, ProtocolGatewayDocKind>>,
  Expect<Equal<GatewayTicketRow, ProtocolGatewayTicketRow>>,
  Expect<Equal<GatewayRpcResponseMap["listMemoryFacts"], ListMemoryFactsResponse>>,
  Expect<Equal<GatewayRpcResponseMap["listPrompts"], ListPromptsResponse>>,
  Expect<Equal<GatewayRpcResponseMap["listScores"], ListScoresResponse>>,
  Expect<Equal<GatewayRpcResponseMap["listScoresForRuns"], ListScoresForRunsResponse>>,
  Expect<Equal<GatewayRpcResponseMap["getScoreDetail"], GetScoreDetailResponse>>,
  Expect<Equal<GatewayRpcResponseMap["listTickets"], ListTicketsResponse>>,
  Expect<Equal<GatewayRpcResponseMap["createTicket"], ProtocolGatewayTicketRow>>,
  Expect<Equal<GatewayRpcResponseMap["updateTicket"], ProtocolGatewayTicketRow>>,
  Expect<Equal<GatewayRpcResponseMap["listUsageReports"], CanonicalUsageReport[]>>,
  Expect<Equal<UsageReport, CanonicalUsageReport>>,
  Expect<Equal<GatewayAsyncState<string>["data"], string | undefined>>,
];

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

const typedRpcRequestMethods = {
  launchRun: "launchRun",
  resumeRun: "resumeRun",
  cancelRun: "cancelRun",
  pauseRun: "pauseRun",
  hijackRun: "hijackRun",
  rewindRun: "rewindRun",
  submitApproval: "submitApproval",
  submitSignal: "submitSignal",
  getRun: "getRun",
  listRunTokenUsage: "listRunTokenUsage",
  listRuns: "listRuns",
  listRunDescendants: "listRunDescendants",
  getSchemaSignature: "getSchemaSignature",
  listWorkflows: "listWorkflows",
  listApprovals: "listApprovals",
  listDocs: "listDocs",
  streamRunEvents: "streamRunEvents",
  streamDevTools: "streamDevTools",
  getDevToolsSnapshot: "getDevToolsSnapshot",
  getNodeOutput: "getNodeOutput",
  getNodeDiff: "getNodeDiff",
  getRunDiff: "getRunDiff",
  whatHappened: "whatHappened",
  cronList: "cronList",
  cronCreate: "cronCreate",
  cronDelete: "cronDelete",
  cronRun: "cronRun",
  listAccounts: "listAccounts",
  listUsageReports: "listUsageReports",
  listMemoryFacts: "listMemoryFacts",
  listPrompts: "listPrompts",
  listScores: "listScores",
  listScoresForRuns: "listScoresForRuns",
  getScoreDetail: "getScoreDetail",
  listTickets: "listTickets",
  createTicket: "createTicket",
  updateTicket: "updateTicket",
  deleteTicket: "deleteTicket",
  createBrowserSession: "createBrowserSession",
  browserAct: "browserAct",
  browserContext: "browserContext",
  browserPick: "browserPick",
  closeBrowserSession: "closeBrowserSession",
  listBrowserSessions: "listBrowserSessions",
} satisfies Record<GatewayRpcMethod, keyof GatewayRpcRequestMap>;

const typedRpcResponseMethods = typedRpcRequestMethods satisfies Record<GatewayRpcMethod, keyof GatewayRpcResponseMap>;

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
  test("keeps the gateway-react legacy subpath facade without a direct gateway dependency", async () => {
    const legacySubpath = await import("@smithers-orchestrator/gateway-react/useGatewayActions");
    const manifest = (await Bun.file(new URL("../../gateway-react/package.json", import.meta.url)).json()) as {
      exports?: Record<string, unknown>;
      dependencies?: Record<string, string>;
    };

    expect(legacySubpath.useGatewayActions).toBeFunction();
    expect(manifest.exports?.["./*"]).toEqual({
      types: "./src/*.ts",
      import: "./src/*.ts",
      default: "./src/*.ts",
    });
    expect(manifest.dependencies?.["@smithers-orchestrator/gateway"]).toBeUndefined();
  });

  test("typed RPC maps cover every stable gateway method", () => {
    expect(Object.keys(typedRpcRequestMethods).sort()).toEqual([...listGatewayRpcMethods()].sort());
    expect(Object.keys(typedRpcResponseMethods).sort()).toEqual([...listGatewayRpcMethods()].sort());
  });

  test("normalizes base URLs and sends typed JSON RPC requests with auth headers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return okResponse({ runId: "run-1", workflow: "deploy", system: false });
    };
    const client = new SmithersGatewayClient({
      baseUrl: "http://gateway.local///",
      token: "secret-token",
      headers: { "x-client": "test" },
      fetch: fetchImpl,
    });

    const result = await client.launchRun({ workflow: "deploy", input: { sha: "abc123" } });

    expect(result).toEqual({ runId: "run-1", workflow: "deploy", system: false });
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
      fetch: async () =>
        errorResponse(
          {
            code: "Forbidden",
            message: "Missing scope.",
            requiredScope: "run:write",
            refresh: "reauth",
            details: { scope: "run:write" },
          },
          403,
        ),
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
    await client.listRunDescendants({ runId: "run-1" });
    await client.listApprovals();
    await client.getDevToolsSnapshot({ runId: "run-1", frameNo: 2 });
    await client.getNodeOutput({ runId: "run-1", nodeId: "task" });
    await client.getNodeDiff({ runId: "run-1", nodeId: "task" });
    await client.getRunDiff({ runId: "run-1" });
    await client.whatHappened({ runId: "run-1", nodeId: "task" });
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
      "listRunDescendants",
      "listApprovals",
      "getDevToolsSnapshot",
      "getNodeOutput",
      "getNodeDiff",
      "getRunDiff",
      "whatHappened",
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

  test("preserves a blocked rewind effect report on GatewayRpcError.details", async () => {
    const ws = new FakeWebSocket("ws://gateway.local");
    const connection = new SmithersGatewayConnection(ws as unknown as WebSocket);
    const pending = connection.requestRaw("rewindRun", {
      runId: "run-1",
      frameNo: 0,
      confirm: true,
    });
    const request = ws.lastRequest();
    ws.receive({
      type: "res",
      id: request.id,
      ok: false,
      error: {
        code: "TIME_TRAVEL_SIDE_EFFECT_BLOCKED",
        message: "blocked",
        details: {
          report: {
            blocking: [
              {
                kind: "tool",
                toolName: "publish",
                nodeId: "task",
                iteration: 0,
                attempt: 1,
                seq: 1,
                effectStatus: "succeeded",
                idempotent: false,
                hasRevert: false,
                startedAtMs: 1,
              },
            ],
            revertible: [],
            warnings: [],
          },
        },
      },
    });

    await pending.catch((error: GatewayRpcError) => {
      expect(error.details?.report?.blocking[0]?.toolName).toBe("publish");
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

  test("delivers queued events in order below the configured limits", async () => {
    const ws = new FakeWebSocket("ws://gateway.local");
    const connection = new SmithersGatewayConnection(ws as unknown as WebSocket, {
      maxQueuedEvents: 3,
      maxQueuedEventBytes: 10_000,
    });
    const frames = [1, 2, 3].map((seq) => ({
      type: "event",
      event: "run.event",
      seq,
      stateVersion: 1,
      payload: { runId: "run-1", streamId: "stream-1" },
    }));

    for (const frame of frames) {
      ws.receive(frame);
    }

    const iterator = connection.events();
    await expect(iterator.next()).resolves.toMatchObject({ value: { seq: 1 } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { seq: 2 } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { seq: 3 } });
    connection.close();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test("closes with a typed error when the queued event count exceeds its limit", async () => {
    const ws = new FakeWebSocket("ws://gateway.local");
    const connection = new SmithersGatewayConnection(ws as unknown as WebSocket, {
      maxQueuedEvents: 2,
      maxQueuedEventBytes: 10_000,
    });

    for (let seq = 1; seq <= 3; seq += 1) {
      ws.receive({
        type: "event",
        event: "run.event",
        seq,
        stateVersion: 1,
        payload: { runId: "run-1", streamId: "stream-1" },
      });
    }

    expect(connection.closed).toBe(true);
    expect(connection.queue).toHaveLength(1);
    expect(ws.closeCalls).toBe(1);
    await expect(connection.events().next()).rejects.toMatchObject({
      name: "GatewayRpcError",
      method: "websocket",
      code: GATEWAY_EVENT_BACKPRESSURE_CODE,
    });
    expect(connection.queue).toHaveLength(0);
  });

  test("closes when queued serialized event bytes exceed their limit", async () => {
    const ws = new FakeWebSocket("ws://gateway.local");
    const frame = {
      type: "event",
      event: "run.event",
      seq: 1,
      stateVersion: 1,
      payload: { value: "🚀" },
    };
    const frameBytes = new TextEncoder().encode(JSON.stringify(frame)).byteLength;
    const connection = new SmithersGatewayConnection(ws as unknown as WebSocket, {
      maxQueuedEvents: 10,
      maxQueuedEventBytes: frameBytes,
    });

    ws.receive(frame);
    ws.receive({ ...frame, seq: 2 });

    expect(connection.closed).toBe(true);
    expect(connection.queue).toHaveLength(1);
    await expect(connection.events().next()).rejects.toMatchObject({
      code: GATEWAY_EVENT_BACKPRESSURE_CODE,
      details: { maxQueuedEventBytes: frameBytes },
    });
    expect(ws.closeCalls).toBe(1);
  });

  test("clears queued frames after an unobserved WebSocket close", async () => {
    const ws = new FakeWebSocket("ws://gateway.local");
    const connection = new SmithersGatewayConnection(ws as unknown as WebSocket);
    ws.receive({
      type: "event",
      event: "run.event",
      seq: 1,
      stateVersion: 1,
      payload: { runId: "run-1" },
    });

    expect(connection.queue).toHaveLength(1);
    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(connection.closed).toBe(true);
    expect(connection.queue).toHaveLength(0);
  });

  test("abort stops the event stream without draining queued frames", async () => {
    const ws = new FakeWebSocket("ws://gateway.local");
    const connection = new SmithersGatewayConnection(ws as unknown as WebSocket);
    const controller = new AbortController();
    const next = connection.events(controller.signal).next();
    await Promise.resolve();

    ws.receive({
      type: "event",
      event: "run.event",
      seq: 1,
      stateVersion: 1,
      payload: { runId: "run-1", streamId: "stream-1", event: "task.started" },
    });
    controller.abort();

    await expect(next).resolves.toEqual({ done: true, value: undefined });
    expect(ws.closeCalls).toBe(1);
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
