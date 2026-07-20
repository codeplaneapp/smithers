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
import { loadBudget } from "../budgets/loadBudget.ts";

const WORKFLOW_KEY = "case09-workflow";

type RunEventPayload = {
  seq?: number;
};

function makeDbPath(): string {
  return join(
    tmpdir(),
    `smithers-case09-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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

describe("case 09: subscriber reconnect with afterSeq against real Gateway", () => {
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

    gateway = new Gateway();
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

  test("disconnect mid-stream and reconnect with afterSeq replays without gap or dup", async () => {
    const latencyBudget = (await loadBudget("latency")) as {
      reconnectAfterSeqMaxMs: number;
    };
    const gw = gateway!;
    const port = getPort(server!);
    const runId = "case09-run-1";

    const adapter = gw.adapterForWorkflow(workflow!);
    await adapter.insertRun({
      runId,
      workflowName: WORKFLOW_KEY,
      status: "running",
      createdAtMs: Date.now(),
    });

    const initialCount = 12;
    const interruptAfterSeq = 5;
    const tailCount = 8;

    for (let i = 0; i < initialCount; i++) {
      gw.broadcastEvent("node.started", { runId, nodeId: `n${i}`, state: "started", iteration: 0 });
    }

    const client = new SmithersGatewayClient({ baseUrl: `http://127.0.0.1:${port}` });
    const firstSeqs: number[] = [];

    for await (const frame of client.streamRunEvents({ runId, afterSeq: 0 })) {
      if (frame.event !== "run.event") continue;
      const seq = (frame.payload as RunEventPayload).seq;
      if (typeof seq !== "number") continue;
      firstSeqs.push(seq);
      if (seq >= interruptAfterSeq) break;
    }

    expect(firstSeqs.length).toBeGreaterThan(0);
    expect(firstSeqs[0]).toBe(1);
    const firstLastSeq = firstSeqs[firstSeqs.length - 1]!;
    expect(firstLastSeq).toBeGreaterThanOrEqual(interruptAfterSeq);
    for (let i = 1; i < firstSeqs.length; i++) {
      expect(firstSeqs[i]).toBe(firstSeqs[i - 1]! + 1);
    }

    for (let i = 0; i < tailCount; i++) {
      gw.broadcastEvent("node.started", {
        runId,
        nodeId: `n${initialCount + i}`,
        state: "started",
        iteration: 0,
      });
    }

    const totalExpected = initialCount + tailCount;
    const expectedTailCount = totalExpected - firstLastSeq;

    const reconnectStartedAt = performance.now();
    const secondSeqs: number[] = [];

    for await (const frame of client.streamRunEvents({ runId, afterSeq: firstLastSeq })) {
      if (frame.event !== "run.event") continue;
      const seq = (frame.payload as RunEventPayload).seq;
      if (typeof seq !== "number") continue;
      secondSeqs.push(seq);
      if (secondSeqs.length >= expectedTailCount) break;
    }

    const reconnectElapsedMs = performance.now() - reconnectStartedAt;
    expect(reconnectElapsedMs).toBeLessThanOrEqual(latencyBudget.reconnectAfterSeqMaxMs);

    expect(secondSeqs.length).toBe(expectedTailCount);
    expect(secondSeqs[0]).toBe(firstLastSeq + 1);
    for (let i = 1; i < secondSeqs.length; i++) {
      expect(secondSeqs[i]).toBe(secondSeqs[i - 1]! + 1);
    }

    const merged = [...firstSeqs, ...secondSeqs];
    expect(merged.length).toBe(totalExpected);
    expect(new Set(merged).size).toBe(totalExpected);
    for (let i = 0; i < totalExpected; i++) {
      expect(merged[i]).toBe(i + 1);
    }
  });

  test("afterSeq=K returns exactly events with seq > K against real Gateway", async () => {
    const gw = gateway!;
    const port = getPort(server!);
    const runId = "case09-run-2";

    const adapter = gw.adapterForWorkflow(workflow!);
    await adapter.insertRun({
      runId,
      workflowName: WORKFLOW_KEY,
      status: "running",
      createdAtMs: Date.now(),
    });

    const total = 20;
    const cutoff = 9;

    for (let i = 0; i < total; i++) {
      gw.broadcastEvent("node.started", { runId, nodeId: `n${i}`, state: "started", iteration: 0 });
    }

    const client = new SmithersGatewayClient({ baseUrl: `http://127.0.0.1:${port}` });
    const seqs: number[] = [];
    const expectedCount = total - cutoff;

    for await (const frame of client.streamRunEvents({ runId, afterSeq: cutoff })) {
      if (frame.event !== "run.event") continue;
      const seq = (frame.payload as RunEventPayload).seq;
      if (typeof seq !== "number") continue;
      seqs.push(seq);
      if (seqs.length >= expectedCount) break;
    }

    expect(seqs.length).toBe(expectedCount);
    expect(seqs.every((s) => s > cutoff)).toBe(true);
    expect(new Set(seqs).size).toBe(seqs.length);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1]! + 1);
    }
  });

  test("afterSeq equal to current last seq yields zero replay events within timeout", async () => {
    const gw = gateway!;
    const port = getPort(server!);
    const runId = "case09-run-3";

    const adapter = gw.adapterForWorkflow(workflow!);
    await adapter.insertRun({
      runId,
      workflowName: WORKFLOW_KEY,
      status: "running",
      createdAtMs: Date.now(),
    });

    const total = 4;
    for (let i = 0; i < total; i++) {
      gw.broadcastEvent("node.started", { runId, nodeId: `n${i}`, state: "started", iteration: 0 });
    }

    const client = new SmithersGatewayClient({ baseUrl: `http://127.0.0.1:${port}` });
    const events: number[] = [];
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 200);

    try {
      for await (const frame of client.streamRunEvents({ runId, afterSeq: total }, { signal: ctrl.signal })) {
        if (frame.event !== "run.event") continue;
        const seq = (frame.payload as RunEventPayload).seq;
        if (typeof seq === "number") events.push(seq);
      }
    } catch (error) {
      expect((error as Error).name).toBe("AbortError");
    } finally {
      clearTimeout(timeout);
    }

    expect(events.length).toBe(0);
  });
});
