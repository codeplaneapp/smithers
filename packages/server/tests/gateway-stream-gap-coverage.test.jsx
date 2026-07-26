/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { Gateway } from "../src/gateway.js";

/**
 * Drives the streamRunEvents gap-resync replay path: when a subscriber asks for
 * events older than the retained window's earliest seq, the gateway rebuilds a
 * run snapshot (exercising the node-state summary reduce) and emits run.gap_resync.
 * A second scenario forces the replay to throw so the run.error catch runs.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPort(server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

class GatewayClient {
  messages = [];
  constructor(ws) {
    this.ws = ws;
    ws.on("message", (raw) => this.messages.push(JSON.parse(String(raw))));
  }
  async waitFor(predicate, timeoutMs = 5000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) return this.messages.splice(index, 1)[0];
      await sleep(10);
    }
    throw new Error(`Timed out waiting for gateway message`);
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

async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const client = new GatewayClient(ws);
  await client.waitFor((m) => m.type === "event" && m.event === "connect.challenge");
  const hello = await client.request("connect", {
    minProtocol: 1,
    maxProtocol: 1,
    client: { id: "gap-resync-test", version: "1.0.0", platform: "bun-test" },
  });
  expect(hello.ok).toBe(true);
  return client;
}

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {}
  }
});

function bootGateway(name) {
  const dbPath = join(tmpdir(), `smithers-gap-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const { smithers, Workflow, Task, outputs } = createSmithers({ result: z.object({ value: z.number() }) }, { dbPath });
  const workflow = smithers(() => (
    <Workflow name="gap">
      <Task id="task1" output={outputs.result}>
        {{ value: 1 }}
      </Task>
    </Workflow>
  ));
  const gateway = new Gateway({});
  gateway.register("gap", workflow);
  cleanups.push(() => {
    for (const suffix of ["", "-shm", "-wal"]) {
      try {
        rmSync(`${dbPath}${suffix}`, { force: true });
      } catch {}
    }
  });
  return { gateway, workflow, dbPath };
}

// Seed a run-event window whose earliest seq is > 1 so an afterSeq=0 subscription
// detects a gap and replays via a rebuilt snapshot.
function seedWindowGap(gateway, runId) {
  const frame = (seq) => ({
    apiVersion: 1,
    type: "RunEvent",
    runId,
    event: "run.event",
    payload: { runId, seq, event: "node.finished", payload: { nodeId: "task1" } },
    seq,
    stateVersion: seq,
  });
  gateway.runEventWindows.set(runId, { nextSeq: 6, window: [frame(5), frame(6)] });
}

describe("streamRunEvents gap resync", () => {
  async function launchAndFinish(client) {
    const launched = await client.request("launchRun", { workflow: "gap", input: {} });
    expect(launched.ok).toBe(true);
    const runId = launched.payload.runId;
    for (let i = 0; i < 200; i += 1) {
      const got = await client.request("getRun", { runId });
      if (got.ok && ["finished", "failed"].includes(got.payload?.status)) break;
      await sleep(25);
    }
    return runId;
  }

  test("rebuilds a run snapshot and emits run.gap_resync", async () => {
    const { gateway } = bootGateway("ok");
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => gateway.close());
    const port = getPort(server);

    const client = await connect(port);
    cleanups.push(() => client.close());
    // A real finished run so buildRunSnapshot resolves and its node-state summary
    // reduce runs over the persisted task node.
    const runId = await launchAndFinish(client);
    seedWindowGap(gateway, runId);

    const res = await client.request("streamRunEvents", { runId, afterSeq: 0 });
    expect(res.ok).toBe(true);
    const gap = await client.waitFor((m) => m.type === "event" && m.event === "run.gap_resync");
    expect(gap.payload.runId).toBe(runId);
    // The rebuilt snapshot carries the node-state summary produced by the reduce.
    expect(gap.payload.snapshot).toBeTruthy();
    expect(gap.payload.snapshot.summary).toBeDefined();
  });

  test("buffers live frames until gap replay drains", async () => {
    const { gateway, workflow } = bootGateway("ordered");
    ensureSmithersTables(workflow.db);
    const runId = "run-ordered-replay";
    await new SmithersDb(workflow.db).insertRun({
      runId,
      workflowName: "gap",
      status: "running",
      createdAtMs: Date.now(),
    });
    seedWindowGap(gateway, runId);

    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => gateway.close());
    const port = getPort(server);

    const client = await connect(port);
    cleanups.push(() => client.close());

    const buildSnapshot = gateway.buildRunSnapshot.bind(gateway);
    let releaseReplay;
    const replayBarrier = new Promise((resolve) => {
      releaseReplay = resolve;
    });
    let markReplayStarted;
    const replayStarted = new Promise((resolve) => {
      markReplayStarted = resolve;
    });
    gateway.buildRunSnapshot = async (snapshotRunId) => {
      markReplayStarted();
      await replayBarrier;
      return buildSnapshot(snapshotRunId);
    };

    const res = await client.request("streamRunEvents", { runId, afterSeq: 0 });
    expect(res.ok).toBe(true);
    await replayStarted;

    gateway.broadcastEvent("node.started", { runId, nodeId: "live" });
    await sleep(20);
    expect(
      client.messages.filter(
        (message) =>
          message.type === "event" &&
          message.payload?.streamId === res.payload.streamId &&
          ["run.gap_resync", "run.event"].includes(message.event),
      ),
    ).toHaveLength(0);

    releaseReplay();
    const deadline = Date.now() + 5_000;
    let streamFrames = [];
    while (Date.now() < deadline) {
      streamFrames = client.messages.filter(
        (message) =>
          message.type === "event" &&
          message.payload?.streamId === res.payload.streamId &&
          ["run.gap_resync", "run.event"].includes(message.event),
      );
      if (streamFrames.length === 4) break;
      await sleep(10);
    }

    expect(
      streamFrames.map((message) => (message.event === "run.gap_resync" ? "gap_resync" : message.payload.seq)),
    ).toEqual(["gap_resync", 5, 6, 7]);
  }, 15_000);

  test("broadcasts run.completed failed when a launched run rejects", async () => {
    const { gateway } = bootGateway("fail");
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => gateway.close());
    const port = getPort(server);

    const client = await connect(port);
    cleanups.push(() => client.close());
    // A negative maxOutputBytes passes the gateway frame/RPC checks (which do not
    // range-check it) but fails the engine's validateRunOptions, so runWorkflow
    // REJECTS -> startRun's `.catch` runs (failure metrics + run.completed
    // {status:"failed"} broadcast to subscribers).
    const launched = await client.request("launchRun", { workflow: "gap", input: {}, options: { maxOutputBytes: -1 } });
    expect(launched.ok).toBe(true);
    const runId = launched.payload.runId;
    const completed = await client.waitFor(
      (m) => m.type === "event" && m.event === "run.completed" && m.payload?.runId === runId,
      10000,
    );
    expect(completed.payload.status).toBe("failed");
    expect(completed.payload.error).toBeDefined();
  });

  test("emits run.error when the replay snapshot rebuild throws", async () => {
    const { gateway, workflow } = bootGateway("throw");
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => gateway.close());
    const port = getPort(server);

    const client = await connect(port);
    cleanups.push(() => client.close());
    const runId = await launchAndFinish(client);
    seedWindowGap(gateway, runId);

    // Close the workflow DB so the gap-resync's buildRunSnapshot read throws,
    // driving the replay `.catch` that emits run.error.
    workflow.db.$client.close();

    const res = await client.request("streamRunEvents", { runId, afterSeq: 0 });
    expect(res.ok).toBe(true);
    const err = await client.waitFor((m) => m.type === "event" && m.event === "run.error");
    expect(err.payload.runId).toBe(runId);
    expect(err.payload.error).toBeDefined();
  });
});
