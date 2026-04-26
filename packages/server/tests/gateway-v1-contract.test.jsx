/** @jsxImportSource smithers-orchestrator */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { Gateway } from "../src/gateway.js";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { sleep } from "../../smithers/tests/helpers.js";

function getPort(server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Gateway server did not expose a port");
  }
  return addr.port;
}

function makeDbPath(name) {
  return join(
    tmpdir(),
    `smithers-gateway-v1-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function createValueWorkflow(dbPath) {
  const { smithers, Workflow, Task, outputs } = createSmithers(
    { outputA: z.object({ value: z.number() }) },
    { dbPath },
  );
  return smithers((ctx) => (
    <Workflow name="gateway-v1">
      <Task id="task1" output={outputs.outputA}>
        {{ value: Number(ctx.input.value ?? 1) }}
      </Task>
    </Workflow>
  ));
}

class GatewayClient {
  messages = [];
  constructor(ws) {
    this.ws = ws;
    ws.on("message", (raw) => {
      this.messages.push(JSON.parse(String(raw)));
    });
  }
  async waitFor(predicate, timeoutMs = 5_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) {
        return this.messages.splice(index, 1)[0];
      }
      await sleep(10);
    }
    throw new Error(`Timed out waiting for gateway message: ${JSON.stringify(this.messages)}`);
  }
  async request(method, params) {
    const id = `${method}-${Math.random().toString(36).slice(2)}`;
    this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    return this.waitFor((message) => message.type === "res" && message.id === id);
  }
  async close() {
    if (this.ws.readyState === this.ws.CLOSED) return;
    await new Promise((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

async function connectGateway(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const client = new GatewayClient(ws);
  await client.waitFor((message) => message.type === "event" && message.event === "connect.challenge");
  const hello = await client.request("connect", {
    minProtocol: 1,
    maxProtocol: 1,
    client: { id: "v1-test", version: "1.0.0", platform: "bun-test" },
    auth: { token },
  });
  expect(hello.ok).toBe(true);
  return client;
}

async function postRpc(port, method, token, body) {
  return fetch(`http://127.0.0.1:${port}/v1/rpc/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

describe("Gateway v1 contract", () => {
  let gateway;
  let server;
  let dbPaths = [];

  beforeEach(() => {
    gateway = undefined;
    server = undefined;
    dbPaths = [];
  });

  afterEach(async () => {
    if (gateway) {
      await gateway.close();
    }
    for (const dbPath of dbPaths) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }
  });

  test("serves stable HTTP RPCs with the v1 response header", async () => {
    const dbPath = makeDbPath("http");
    dbPaths.push(dbPath);
    gateway = new Gateway({
      auth: {
        mode: "token",
        tokens: {
          "operator-token": {
            role: "operator",
            scopes: ["run:read", "run:write"],
            userId: "user:v1",
          },
        },
      },
    });
    gateway.register("basic", createValueWorkflow(dbPath));
    server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);

    const launch = await postRpc(port, "launchRun", "operator-token", {
      workflow: "basic",
      input: { value: 5 },
    });
    expect(launch.status).toBe(200);
    expect(launch.headers.get("x-smithers-api-version")).toBe("v1");
    const launched = await launch.json();
    expect(launched.apiVersion).toBe("v1");
    expect(launched.ok).toBe(true);

    let run;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await postRpc(port, "getRun", "operator-token", {
        runId: launched.payload.runId,
      });
      expect(response.headers.get("x-smithers-api-version")).toBe("v1");
      const payload = await response.json();
      if (payload.ok && payload.payload.status === "finished") {
        run = payload.payload;
        break;
      }
      await sleep(25);
    }
    expect(run?.workflowKey).toBe("basic");
    expect(run?.status).toBe("finished");
  });

  test("returns scoped Forbidden errors and expired-token refresh hints", async () => {
    const dbPath = makeDbPath("auth");
    dbPaths.push(dbPath);
    gateway = new Gateway({
      auth: {
        mode: "token",
        tokens: {
          "reader-token": {
            role: "viewer",
            scopes: ["run:read"],
            userId: "user:reader",
          },
          "expired-token": {
            role: "viewer",
            scopes: ["run:read"],
            userId: "user:expired",
            expiresAtMs: Date.now() - 1,
          },
        },
      },
    });
    gateway.register("basic", createValueWorkflow(dbPath));
    server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);

    const forbidden = await postRpc(port, "launchRun", "reader-token", {
      workflow: "basic",
      input: {},
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("x-smithers-api-version")).toBe("v1");
    const forbiddenBody = await forbidden.json();
    expect(forbiddenBody.error).toEqual(
      expect.objectContaining({
        version: "v1",
        code: "FORBIDDEN",
        requiredScope: "run:write",
      }),
    );

    const expired = await postRpc(port, "listRuns", "expired-token", {
      filter: { limit: 1 },
    });
    expect(expired.status).toBe(401);
    const expiredBody = await expired.json();
    expect(expiredBody.error).toEqual(
      expect.objectContaining({
        version: "v1",
        code: "UNAUTHORIZED",
        refresh: "smithers token issue",
      }),
    );
  });

  test("streamRunEvents emits GapResync and snapshot after replay window truncation", async () => {
    const dbPath = makeDbPath("stream");
    dbPaths.push(dbPath);
    const workflow = createValueWorkflow(dbPath);
    ensureSmithersTables(workflow.db);
    const adapter = new SmithersDb(workflow.db);
    await adapter.insertRun({
      runId: "run-gap",
      workflowName: "gateway-v1",
      status: "running",
      createdAtMs: Date.now(),
    });
    gateway = new Gateway({
      eventWindowSize: 2,
      auth: {
        mode: "token",
        tokens: {
          "reader-token": {
            role: "viewer",
            scopes: ["run:read"],
            userId: "user:reader",
          },
        },
      },
    });
    gateway.register("basic", workflow);
    server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);
    gateway.broadcastEvent("node.started", { runId: "run-gap", nodeId: "a" });
    gateway.broadcastEvent("node.finished", { runId: "run-gap", nodeId: "a" });
    gateway.broadcastEvent("run.completed", { runId: "run-gap", status: "finished" });

    const client = await connectGateway(port, "reader-token");
    const subscribed = await client.request("streamRunEvents", {
      runId: "run-gap",
      afterSeq: 0,
    });
    expect(subscribed.ok).toBe(true);
    expect(subscribed.payload.currentSeq).toBe(3);
    const gap = await client.waitFor(
      (message) => message.type === "event" && message.event === "run.gap_resync",
    );
    expect(gap.payload).toEqual(
      expect.objectContaining({
        type: "GapResync",
        fromSeq: 1,
        toSeq: 1,
      }),
    );
    expect(gap.payload.snapshot.runId).toBe("run-gap");
    const replay = await client.waitFor(
      (message) => message.type === "event" && message.event === "run.event" && message.payload.seq === 2,
    );
    expect(replay.payload.event).toBe("node.finished");
    await client.close();
  });
});
