import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { z } from "zod";
import { createSmithers } from "smthrs";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { SmithersGatewayClient } from "@smthrs/gateway-client";
import { Gateway, type SmithersWorkflow } from "@smthrs/server/gateway";
import { loadBudget } from "../budgets/loadBudget.ts";

// case16 — N=5 subscribers on one run against the REAL Gateway.
//
// This used to fabricate its own `_smithers_events` table and hand-roll a
// WebSocket "subscription" server that read the rows and streamed them, so it
// validated a mock of the fan-out contract, not the product. It now drives the
// real @smthrs/server Gateway: events are published through the
// real `broadcastEvent` path (persisted + seq-assigned by the product) and each
// subscriber consumes the real `streamRunEvents` WS surface via
// SmithersGatewayClient — the same subscription case09/case15/case28 exercise.
// The assertions check the real fan-out (identical, ordered, gap-free seq sets)
// and that five concurrent subscribers keep RSS growth under budget.

const WORKFLOW_KEY = "case16-workflow";

type RunEventPayload = {
  seq?: number;
};

function makeDbPath(): string {
  return join(
    tmpdir(),
    `smithers-case16-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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

function tryGc(): void {
  const bunGc = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc;
  if (typeof bunGc === "function") bunGc(true);
}

describe("case 16: N=5 subscribers on one run; bounded memory; consistent state", () => {
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

  test("five concurrent subscribers see identical seq sets in order, RSS growth under budget", async () => {
    const budget = (await loadBudget("memory")) as {
      subscriberFanoutN5: { rssGrowthBytesMax: number };
    };
    // Growth over this test's own baseline, not absolute RSS: the faults
    // suite shares one bun process, so absolute RSS reflects whatever ran
    // before this file, not this path's leakage.
    const rssGrowthBudget = budget.subscriberFanoutN5.rssGrowthBytesMax;

    const gw = gateway!;
    const port = getPort(server!);
    const runId = "case16-run";
    const eventCount = 500;
    const subscriberCount = 5;

    const adapter = gw.adapterForWorkflow(workflow!);
    await adapter.insertRun({
      runId,
      workflowName: WORKFLOW_KEY,
      status: "running",
      createdAtMs: Date.now(),
    });

    // Publish every event through the real Gateway broadcast path (persisted
    // and seq-assigned by the product) before the subscribers attach, so each
    // subscriber replays the same durable history from afterSeq: 0.
    for (let i = 0; i < eventCount; i++) {
      gw.broadcastEvent("node.started", {
        runId,
        nodeId: `n${i}`,
        state: "started",
        iteration: 0,
      });
    }

    tryGc();
    const baselineRss = process.memoryUsage().rss;

    let peakRss = baselineRss;
    const sampleInterval = setInterval(() => {
      const current = process.memoryUsage().rss;
      if (current > peakRss) peakRss = current;
    }, 5);

    let seqsPerSubscriber: number[][];
    try {
      seqsPerSubscriber = await Promise.all(
        Array.from({ length: subscriberCount }, async () => {
          const client = new SmithersGatewayClient({ baseUrl: `http://127.0.0.1:${port}` });
          const seqs: number[] = [];
          for await (const frame of client.streamRunEvents({ runId, afterSeq: 0 })) {
            if (frame.event !== "run.event") continue;
            const seq = (frame.payload as RunEventPayload).seq;
            if (typeof seq !== "number") continue;
            seqs.push(seq);
            if (seqs.length >= eventCount) break;
          }
          return seqs;
        }),
      );
    } finally {
      clearInterval(sampleInterval);
    }

    const finalRss = process.memoryUsage().rss;
    if (finalRss > peakRss) peakRss = finalRss;

    // The real Gateway assigns 1-based sequence numbers, so a fan-out of
    // `eventCount` events yields the contiguous set 1..eventCount for every
    // subscriber, delivered in order with no gap or duplicate.
    const expectedSet = new Set<number>();
    for (let i = 1; i <= eventCount; i += 1) expectedSet.add(i);

    for (const seqs of seqsPerSubscriber) {
      expect(seqs.length).toBe(eventCount);
      for (let i = 1; i < seqs.length; i += 1) {
        expect(seqs[i]).toBe(seqs[i - 1]! + 1);
      }
      expect(seqs[0]).toBe(1);
      expect(seqs[seqs.length - 1]).toBe(eventCount);
      expect(new Set(seqs)).toEqual(expectedSet);
    }

    const rssGrowth = peakRss - baselineRss;
    console.log(
      `[case16] subscribers=${subscriberCount} events=${eventCount} baselineRss=${baselineRss} peakRss=${peakRss} growth=${rssGrowth} growthBudget=${rssGrowthBudget}`,
    );
    expect(rssGrowth).toBeGreaterThanOrEqual(0);
    expect(rssGrowth).toBeLessThan(rssGrowthBudget);
  });
});
