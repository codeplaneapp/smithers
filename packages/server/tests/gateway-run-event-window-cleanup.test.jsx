/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { Gateway } from "../src/gateway.js";

const AUTH = { triggeredBy: "test", scopes: ["*"], role: "operator", tokenId: null };
const RUN_COUNT = 30;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeDbPath(name) {
  return join(
    tmpdir(),
    `smithers-run-event-window-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function getPort(server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Gateway server did not expose a port");
  }
  return addr.port;
}

async function waitUntil(predicate, label, timeoutMs = 10_000) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await sleep(25);
  }
}

function createCleanupWorkflow(dbPath) {
  const { smithers, Workflow, Task, outputs } = createSmithers(
    { out: z.object({ value: z.number() }) },
    { dbPath },
  );
  return smithers(() => (
    <Workflow name="cleanup">
      <Task id="a" output={outputs.out}>
        {{ value: 1 }}
      </Task>
      <Task id="b" needs={["a"]} output={outputs.out}>
        {{ value: 2 }}
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
    if (this.ws.readyState === this.ws.CLOSED) {
      return;
    }
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
    client: { id: "run-event-window-cleanup-test", version: "1.0.0", platform: "bun-test" },
    auth: { token },
  });
  expect(hello.ok).toBe(true);
  return client;
}

describe("gateway run event window cleanup", () => {
  /** @type {Gateway | undefined} */
  let gateway;
  /** @type {string[]} */
  let dbPaths = [];

  afterEach(async () => {
    try {
      await gateway?.close?.();
    } catch {}
    for (const dbPath of dbPaths) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    }
    gateway = undefined;
    dbPaths = [];
  });

  test("drops event windows after completed unsubscribed runs", async () => {
    const dbPath = makeDbPath("many");
    dbPaths.push(dbPath);
    const workflow = createCleanupWorkflow(dbPath);
    gateway = new Gateway({ heartbeatMs: 1000 });
    gateway.register("cleanup", workflow);

    const runIds = Array.from({ length: RUN_COUNT }, (_, index) => `cleanup-${index.toString().padStart(2, "0")}`);
    await Promise.all(
      runIds.map((runId) => gateway.startRun("cleanup", {}, AUTH, runId, { resume: false })),
    );

    await waitUntil(async () => {
      const listed = await gateway.listRunsAcrossWorkflows(RUN_COUNT * 2);
      const byRun = new Map(listed.map((run) => [run.runId, run.status]));
      return runIds.every((runId) => byRun.get(runId) === "finished") && gateway.inflightRuns.size === 0;
    }, "all runs to finish", 45_000);

    await waitUntil(
      () => gateway.runEventWindows.size === 0 && gateway.outOfProcessEventBridgeLastFedSeq.size === 0,
      "completed run event windows to be freed",
    );

    expect(gateway.runEventWindows.size).toBe(0);
    expect(gateway.outOfProcessEventBridgeLastFedSeq.size).toBe(0);
    for (const runId of runIds) {
      expect(gateway.runEventWindows.has(runId)).toBe(false);
      expect(gateway.outOfProcessEventBridgeLastFedSeq.has(runId)).toBe(false);
    }
  }, 60_000);

  test("keeps a terminal run window briefly for late replay before cleanup", async () => {
    const dbPath = makeDbPath("late");
    dbPaths.push(dbPath);
    const workflow = createCleanupWorkflow(dbPath);
    gateway = new Gateway({ heartbeatMs: 1000 });
    gateway.register("cleanup", workflow);
    ensureSmithersTables(workflow.db);
    const adapter = gateway.adapterForWorkflow(workflow);
    const runId = "late-replay-window";
    await adapter.insertRun({
      runId,
      workflowName: "cleanup",
      status: "running",
      createdAtMs: Date.now(),
    });

    gateway.broadcastEvent("node.started", { runId, nodeId: "a" });
    gateway.broadcastEvent("run.completed", { runId, status: "finished" });

    expect(gateway.getRunEventCurrentSeq(runId)).toBe(2);
    expect(gateway.runEventWindows.has(runId)).toBe(true);
    expect(gateway.terminalRunEventWindows.has(runId)).toBe(true);

    await waitUntil(
      () =>
        !gateway.runEventWindows.has(runId) &&
        !gateway.terminalRunEventWindows.has(runId) &&
        !gateway.terminalRunEventWindowTimers.has(runId),
      "late replay terminal window cleanup",
    );
  });

  test("keeps a terminal run window while a streamRunEvents subscriber is active", async () => {
    const dbPath = makeDbPath("subscriber");
    dbPaths.push(dbPath);
    const workflow = createCleanupWorkflow(dbPath);
    gateway = new Gateway({
      heartbeatMs: 1000,
      auth: {
        mode: "token",
        tokens: {
          "op-token": {
            role: "operator",
            scopes: ["*"],
            userId: "user:test",
          },
        },
      },
    });
    gateway.register("cleanup", workflow);
    ensureSmithersTables(workflow.db);
    const adapter = gateway.adapterForWorkflow(workflow);
    const runId = "subscriber-pins-window";
    await adapter.insertRun({
      runId,
      workflowName: "cleanup",
      status: "running",
      createdAtMs: Date.now(),
    });

    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const client = await connectGateway(getPort(server), "op-token");
    const subscribed = await client.request("streamRunEvents", { runId });
    expect(subscribed.ok).toBe(true);

    await waitUntil(() => gateway.getRunEventSubscriberCount(runId) === 1, "run event subscriber registration");
    gateway.outOfProcessEventBridgeLastFedSeq.set(runId, 123);
    gateway.broadcastEvent("node.started", { runId, nodeId: "a" });
    gateway.broadcastEvent("run.completed", { runId, status: "finished" });

    expect(gateway.runEventWindows.has(runId)).toBe(true);
    expect(gateway.outOfProcessEventBridgeLastFedSeq.get(runId)).toBe(123);
    expect(gateway.terminalRunEventWindows.has(runId)).toBe(true);

    await client.close();
    await waitUntil(
      () =>
        !gateway.runEventWindows.has(runId) &&
        !gateway.outOfProcessEventBridgeLastFedSeq.has(runId) &&
        !gateway.runEventSubscriberCounts.has(runId),
      "terminal run window cleanup after subscriber detach",
    );

    expect(gateway.runEventWindows.has(runId)).toBe(false);
    expect(gateway.outOfProcessEventBridgeLastFedSeq.has(runId)).toBe(false);
    expect(gateway.terminalRunEventWindows.has(runId)).toBe(false);
  });
});
