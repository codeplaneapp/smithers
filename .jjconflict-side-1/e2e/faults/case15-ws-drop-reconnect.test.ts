import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersGatewayClient } from "@smithers-orchestrator/gateway-client";
import { Gateway, type SmithersWorkflow } from "@smithers-orchestrator/server/gateway";

const WORKFLOW_KEY = "case15-workflow";

type RunEventPayload = {
  seq?: number;
};

type GatewayWithConnections = {
  connections: Set<{ ws?: { terminate?(): void; readyState?: number } }>;
};

function makeDbPath(): string {
  return join(
    tmpdir(),
    `smithers-case15-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function createStreamingWorkflow(dbPath: string) {
  const { smithers, Workflow, Task, outputs, db } = createSmithers(
    { done: z.object({ ok: z.boolean() }) },
    { dbPath },
  );
  const workflow = smithers(() =>
    React.createElement(
      Workflow,
      { name: WORKFLOW_KEY },
      React.createElement(Task, { id: "t1", output: outputs.done, children: { ok: true } }),
    ),
  );
  return { workflow, db };
}

function getPort(server: { address(): unknown }): number {
  const address = server.address();
  if (
    !address ||
    typeof address === "string" ||
    typeof (address as { port?: unknown }).port !== "number"
  ) {
    throw new Error("Gateway server did not expose a port");
  }
  return (address as { port: number }).port;
}

function terminateAllConnections(gw: Gateway): void {
  for (const conn of (gw as unknown as GatewayWithConnections).connections) {
    try {
      conn.ws?.terminate?.();
    } catch {
      // ignore failures on already-closed sockets
    }
  }
}

describe("case 15: drop authenticated streamRunEvents mid-stream, reconnect with afterSeq", () => {
  let gateway: Gateway | undefined;
  let server: { address(): unknown } | undefined;
  let workflow: SmithersWorkflow | undefined;
  const dbPaths: string[] = [];

  beforeEach(async () => {
    const dbPath = makeDbPath();
    dbPaths.push(dbPath);
    const result = createStreamingWorkflow(dbPath);
    ensureSmithersTables(result.db);
    workflow = result.workflow as SmithersWorkflow;

    gateway = new Gateway({
      auth: {
        mode: "token",
        tokens: {
          "op-token": { role: "operator", scopes: ["*"], userId: "user:will" },
        },
      },
    });
    gateway.register(WORKFLOW_KEY, workflow);
    server = (await gateway.listen({ port: 0, host: "127.0.0.1" })) as { address(): unknown };
  });

  afterEach(async () => {
    if (gateway) {
      await gateway.close();
      gateway = undefined;
      server = undefined;
    }
    for (const dbPath of dbPaths) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }
    dbPaths.length = 0;
  });

  test("abrupt drop mid-stream then reconnect with afterSeq replays without gap or dup over 100+ events", async () => {
    const gw = gateway!;
    const port = getPort(server!);
    const runId = "case15-run-1";
    const initialCount = 30;
    const interruptAfterCount = 30;
    const tailCount = 100;

    const adapter = gw.adapterForWorkflow(workflow!);
    await adapter.insertRun({
      runId,
      workflowName: WORKFLOW_KEY,
      status: "running",
      createdAtMs: Date.now(),
    });

    for (let i = 0; i < initialCount; i++) {
      gw.broadcastEvent("node.started", { runId, nodeId: `n${i}`, state: "started", iteration: 0 });
    }

    const client = new SmithersGatewayClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: "op-token",
    });

    const seenSeqs: number[] = [];
    const reconnectAfterSeqs: number[] = [];
    let droppedConnections = false;
    const totalExpected = initialCount + tailCount;
    const ctrl = new AbortController();

    await (async () => {
      for await (const frame of client.streamRunEventsResilient(
        { runId, afterSeq: 0 },
        {
          signal: ctrl.signal,
          backoff: { baseMs: 5, maxMs: 50, random: () => 0.5 },
          onReconnect: (event) => {
            if (typeof event.afterSeq === "number") reconnectAfterSeqs.push(event.afterSeq);
          },
        },
      )) {
        if (frame.event !== "run.event") continue;
        const seq = (frame.payload as RunEventPayload).seq;
        if (typeof seq !== "number") continue;
        seenSeqs.push(seq);

        if (!droppedConnections && seenSeqs.length >= interruptAfterCount) {
          droppedConnections = true;
          terminateAllConnections(gw);
          for (let i = 0; i < tailCount; i++) {
            gw.broadcastEvent("node.started", {
              runId,
              nodeId: `n${initialCount + i}`,
              state: "started",
              iteration: 0,
            });
          }
        }

        if (seenSeqs.length >= totalExpected) break;
      }
    })();

    expect(seenSeqs.length).toBeGreaterThanOrEqual(100);
    expect(seenSeqs.length).toBe(totalExpected);
    expect(new Set(seenSeqs).size).toBe(totalExpected);
    for (let i = 0; i < totalExpected; i++) {
      expect(seenSeqs[i]).toBe(i + 1);
    }
    expect(droppedConnections).toBe(true);
    expect(reconnectAfterSeqs).toContain(interruptAfterCount);
  });

  test("rejects streamRunEvents with an invalid bearer token", async () => {
    const port = getPort(server!);
    const runId = "case15-run-2";

    const adapter = gateway!.adapterForWorkflow(workflow!);
    await adapter.insertRun({
      runId,
      workflowName: WORKFLOW_KEY,
      status: "running",
      createdAtMs: Date.now(),
    });

    const client = new SmithersGatewayClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: "wrong-token",
    });

    await expect(
      client.streamRunEvents({ runId }).next(),
    ).rejects.toMatchObject({
      name: "GatewayRpcError",
    });
  });
});
