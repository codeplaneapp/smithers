/** @jsxImportSource smthrs */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { createSmithers } from "smthrs";
import { Gateway } from "../src/gateway.js";

function makeDbPath() {
  return join(tmpdir(), `smithers-gateway-cancel-attribution-${Date.now()}-${crypto.randomUUID()}.db`);
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeWorkflow(dbPath) {
  const api = createSmithers({ output: z.object({ value: z.number() }) }, { dbPath });
  const started = deferred();
  const release = deferred();
  const workflow = api.smithers(() => (
    <api.Workflow name="cancel-attribution">
      <api.Task id="task" output={api.outputs.output}>
        {async () => {
          started.resolve();
          await release.promise;
          return { value: 1 };
        }}
      </api.Task>
    </api.Workflow>
  ));
  return { workflow, started, release };
}

class RpcWebSocketClient {
  constructor(ws) {
    this.ws = ws;
    this.messages = [];
    ws.on("message", (raw) => this.messages.push(JSON.parse(String(raw))));
  }

  async waitFor(predicate) {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) return this.messages.splice(index, 1)[0];
      await Bun.sleep(10);
    }
    throw new Error(`Timed out waiting for Gateway response: ${JSON.stringify(this.messages)}`);
  }

  async request(id, method, params) {
    this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    return this.waitFor((message) => message.type === "res" && message.id === id);
  }

  async close() {
    if (this.ws.readyState === this.ws.CLOSED) return;
    await new Promise((resolve) => {
      this.ws.once("close", resolve);
      this.ws.close();
    });
  }
}

async function connectWebSocket(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const client = new RpcWebSocketClient(ws);
  await client.waitFor((message) => message.type === "event" && message.event === "connect.challenge");
  const hello = await client.request("connect-1", "connect", {
    minProtocol: 1,
    maxProtocol: 1,
    client: { id: "cancel-test", version: "1", platform: "bun-test", pid: 5432 },
    auth: { token: "operator-token" },
  });
  expect(hello.ok).toBe(true);
  return client;
}

describe("Gateway cancellation attribution", () => {
  let gateway;
  let dbPath;
  let wsClient;
  let releaseActiveRuns;

  afterEach(async () => {
    releaseActiveRuns?.();
    await wsClient?.close();
    await gateway?.close();
    if (dbPath) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    }
  });

  test("persists and exposes HTTP and WebSocket cancellation callers", async () => {
    dbPath = makeDbPath();
    const httpWorkflow = makeWorkflow(dbPath);
    const wsWorkflow = makeWorkflow(dbPath);
    releaseActiveRuns = () => {
      httpWorkflow.release.resolve();
      wsWorkflow.release.resolve();
    };
    gateway = new Gateway({
      auth: {
        mode: "token",
        tokens: {
          "operator-token": {
            role: "operator",
            scopes: ["*"],
            userId: "user:operator",
          },
        },
      },
      heartbeatMs: 1_000,
    });
    gateway.register("cancel-http", httpWorkflow.workflow);
    gateway.register("cancel-ws", wsWorkflow.workflow);
    const adapter = gateway.adapterForWorkflow(httpWorkflow.workflow);
    for (const runId of ["http-no-pid-run", "legacy-run"]) {
      await adapter.insertRun({
        runId,
        workflowName: "cancel-attribution",
        status: runId === "legacy-run" ? "cancelled" : "running",
        createdAtMs: Date.now(),
      });
    }
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Gateway did not bind a TCP port");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await gateway.startRun(
      "cancel-http",
      {},
      { triggeredBy: "test", scopes: ["*"], role: "operator", tokenId: null },
      "http-run",
    );
    await httpWorkflow.started.promise;
    const activeHttpRun = gateway.activeRuns.get("http-run");
    expect(activeHttpRun).toBeDefined();
    const originalHttpAbort = activeHttpRun.abort.abort.bind(activeHttpRun.abort);
    let httpPersistedAtAbort;
    activeHttpRun.abort.abort = () => {
      httpPersistedAtAbort = Promise.resolve(adapter.getRun("http-run"));
      originalHttpAbort();
    };

    const httpResponse = await fetch(`${baseUrl}/v1/rpc/cancelRun`, {
      method: "POST",
      headers: {
        authorization: "Bearer operator-token",
        "content-type": "application/json",
        "x-request-id": "http-cancel-1",
        "x-smithers-client-pid": "4321",
      },
      body: JSON.stringify({ runId: "http-run" }),
    });
    const httpJson = await httpResponse.json();
    expect(httpResponse.status).toBe(200);
    expect(httpJson.payload).toMatchObject({
      runId: "http-run",
      status: "cancelled",
      cancellationSource: {
        kind: "rpc",
        detail: "http cancellation request",
        requestId: "http-cancel-1",
        clientIdentity: "user:operator",
        clientPid: 4321,
      },
    });
    expect(await httpPersistedAtAbort).toMatchObject({
      status: "cancelled",
      cancelRequestId: "http-cancel-1",
      cancelRequestSource: "rpc",
      cancelRequestDetail: "http cancellation request",
      cancelRequestClientIdentity: "user:operator",
      cancelRequestClientPid: 4321,
    });

    await gateway.startRun(
      "cancel-ws",
      {},
      { triggeredBy: "test", scopes: ["*"], role: "operator", tokenId: null },
      "ws-run",
    );
    await wsWorkflow.started.promise;
    const activeWsRun = gateway.activeRuns.get("ws-run");
    expect(activeWsRun).toBeDefined();
    const originalWsAbort = activeWsRun.abort.abort.bind(activeWsRun.abort);
    let wsPersistedAtAbort;
    activeWsRun.abort.abort = () => {
      wsPersistedAtAbort = Promise.resolve(adapter.getRun("ws-run"));
      originalWsAbort();
    };

    wsClient = await connectWebSocket(address.port);
    const wsResponse = await wsClient.request("ws-cancel-1", "cancelRun", { runId: "ws-run" });
    expect(wsResponse.ok).toBe(true);
    expect(wsResponse.payload).toMatchObject({
      runId: "ws-run",
      status: "cancelled",
      cancellationSource: {
        kind: "rpc",
        detail: "websocket cancellation request",
        requestId: "ws-cancel-1",
        clientIdentity: "user:operator",
        clientPid: 5432,
      },
    });
    expect(await wsPersistedAtAbort).toMatchObject({
      status: "cancelled",
      cancelRequestId: "ws-cancel-1",
      cancelRequestSource: "rpc",
      cancelRequestDetail: "websocket cancellation request",
      cancelRequestClientIdentity: "user:operator",
      cancelRequestClientPid: 5432,
    });

    const getRun = await wsClient.request("get-ws-run", "getRun", { runId: "ws-run" });
    expect(getRun.payload.cancellationSource).toEqual({
      kind: "rpc",
      detail: "websocket cancellation request",
      requestId: "ws-cancel-1",
      clientIdentity: "user:operator",
      clientPid: 5432,
    });

    const noPidResponse = await fetch(`${baseUrl}/v1/api/runs/http-no-pid-run/cancel`, {
      method: "POST",
      headers: {
        authorization: "Bearer operator-token",
        "content-type": "application/json",
        "x-request-id": "http-cancel-no-pid",
      },
      body: "{}",
    });
    const noPidJson = await noPidResponse.json();
    expect(noPidResponse.status).toBe(200);
    expect(noPidJson.data.cancellationSource).toEqual({
      kind: "rpc",
      detail: "http cancellation request",
      requestId: "http-cancel-no-pid",
      clientIdentity: "user:operator",
    });

    const legacyResponse = await wsClient.request("legacy-cancel", "cancelRun", { runId: "legacy-run" });
    expect(legacyResponse.ok).toBe(true);
    expect(legacyResponse.payload).toMatchObject({
      runId: "legacy-run",
      won: false,
      status: "already-terminal",
      terminalStatus: "cancelled",
    });
    expect(legacyResponse.payload).not.toHaveProperty("cancellationSource");
  }, 20_000);

  test("keeps unauthenticated caller identity optional", async () => {
    dbPath = makeDbPath();
    const registered = makeWorkflow(dbPath);
    releaseActiveRuns = registered.release.resolve;
    gateway = new Gateway({ heartbeatMs: 1_000 });
    gateway.register("cancel-attribution", registered.workflow);
    const adapter = gateway.adapterForWorkflow(registered.workflow);
    await adapter.insertRun({
      runId: "anonymous-run",
      workflowName: "cancel-attribution",
      status: "waiting-event",
      createdAtMs: Date.now(),
    });

    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Gateway did not bind a TCP port");
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/rpc/cancelRun`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "anonymous-cancel",
      },
      body: JSON.stringify({ runId: "anonymous-run" }),
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.payload.cancellationSource).toEqual({
      kind: "rpc",
      detail: "http cancellation request",
      requestId: "anonymous-cancel",
    });
    expect(await adapter.getRun("anonymous-run")).toMatchObject({
      cancelRequestId: "anonymous-cancel",
      cancelRequestSource: "rpc",
      cancelRequestDetail: "http cancellation request",
      cancelRequestClientIdentity: null,
      cancelRequestClientPid: null,
    });
  });
});
