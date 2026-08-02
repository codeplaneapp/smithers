// 10+ minute live-stream soak: a busy run streaming over the REAL Gateway +
// SmithersGatewayClient, asserting peak RSS stays under budget. Previously this
// stood up a hand-rolled WebSocketServer + its own _smithers_events table and
// measured the fixture's memory — a no-mocks violation that defeated the whole
// point (a leak in the real Gateway broadcast/window/backpressure path would not
// be caught). It now drives the production live-stream path exactly like
// case15: gateway.broadcastEvent -> Gateway run-event window -> resilient client
// subscriber. Gated behind SMITHERS_E2E_SOAK=1.
import { afterEach, describe, expect, test } from "bun:test";
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

const WORKFLOW_KEY = "case28-workflow";
const SOAK_ENABLED = process.env.SMITHERS_E2E_SOAK === "1";
const DEFAULT_DURATION_MS = 10 * 60_000;
const HARD_CEILING_MS = 12 * 60_000;
const EVENTS_PER_SECOND = 10;
const SAMPLE_INTERVAL_MS = 5_000;
const GC_INTERVAL_MS = 30_000;
const PAYLOAD_BYTES = 200;

function makeDbPath(): string {
  return join(
    tmpdir(),
    `smithers-case28-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

describe("case 28: 10+ min live stream on busy run; RSS within budget", () => {
  let gateway: Gateway | undefined;
  let server: { address(): unknown } | undefined;
  let workflow: SmithersWorkflow | undefined;
  const dbPaths: string[] = [];

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

  test.skipIf(!SOAK_ENABLED)(
    "single subscriber on busy live stream keeps peak RSS under liveStream10min budget",
    async () => {
      const overrideRaw = process.env.SMITHERS_E2E_SOAK_DURATION_MS;
      const overrideMs = overrideRaw ? Number.parseInt(overrideRaw, 10) : NaN;
      const durationMs =
        Number.isFinite(overrideMs) && overrideMs > 0 ? overrideMs : DEFAULT_DURATION_MS;
      const wallCeilingMs = Math.min(HARD_CEILING_MS, durationMs + 2 * 60_000);

      const budget = (await loadBudget("memory")) as {
        liveStream10min: { rssGrowthBytesMax: number };
      };
      // Growth over this test's own baseline, not absolute RSS: the faults
      // suite shares one bun process, so absolute RSS reflects whatever ran
      // before this file, not this path's leakage.
      const rssGrowthBudget = budget.liveStream10min.rssGrowthBytesMax;

      // Boot a real Gateway over a real workflow store.
      const dbPath = makeDbPath();
      dbPaths.push(dbPath);
      const created = createStreamingWorkflow(dbPath);
      ensureSmithersTables(created.db);
      workflow = created.workflow as SmithersWorkflow;
      gateway = new Gateway({
        auth: {
          mode: "token",
          tokens: { "op-token": { role: "operator", scopes: ["*"], userId: "user:will" } },
        },
      });
      gateway.register(WORKFLOW_KEY, workflow);
      server = (await gateway.listen({ port: 0, host: "127.0.0.1" })) as { address(): unknown };

      const gw = gateway;
      const port = getPort(server);
      const runId = "case28-run";
      const intervalMs = 1000 / EVENTS_PER_SECOND;
      const filler = "x".repeat(Math.max(0, PAYLOAD_BYTES - 40));

      const adapter = gw.adapterForWorkflow(workflow);
      await adapter.insertRun({ runId, workflowName: WORKFLOW_KEY, status: "running", createdAtMs: Date.now() });

      // Real resilient subscriber over the Gateway WS.
      const client = new SmithersGatewayClient({ baseUrl: `http://127.0.0.1:${port}`, token: "op-token" });
      const ctrl = new AbortController();
      let receivedCount = 0;
      let gaps = 0;
      let lastSeq = 0;
      const consumer = (async () => {
        try {
          for await (const frame of client.streamRunEventsResilient(
            { runId, afterSeq: 0 },
            { signal: ctrl.signal, backoff: { baseMs: 5, maxMs: 50, random: () => 0.5 } },
          )) {
            if (frame.event !== "run.event") continue;
            const seq = (frame.payload as { seq?: number }).seq;
            if (typeof seq !== "number") continue;
            if (seq !== lastSeq + 1) gaps += 1;
            lastSeq = seq;
            receivedCount += 1;
          }
        }
        catch {
          // aborted at end of soak — expected.
        }
      })();

      // Let the subscriber connect before the busy stream begins.
      await sleep(250);

      tryGc();
      const baselineRss = process.memoryUsage().rss;
      let peakRss = baselineRss;
      const start = Date.now();
      let emitted = 0;

      const sampleHandle = setInterval(() => {
        const current = process.memoryUsage().rss;
        if (current > peakRss) peakRss = current;
      }, SAMPLE_INTERVAL_MS);
      const gcHandle = setInterval(() => tryGc(), GC_INTERVAL_MS);
      const emitHandle = setInterval(() => {
        gw.broadcastEvent("node.started", {
          runId,
          nodeId: `n${emitted}`,
          state: "started",
          iteration: 0,
          filler,
        });
        emitted += 1;
      }, intervalMs);

      try {
        while (Date.now() - start < durationMs) {
          await sleep(250);
          if (Date.now() - start > wallCeilingMs) break;
        }
      }
      finally {
        clearInterval(emitHandle);
        clearInterval(gcHandle);
        clearInterval(sampleHandle);
      }

      // Let the tail drain through the real broadcast path, then stop the stream.
      await sleep(500);
      ctrl.abort();
      await consumer;

      const finalRss = process.memoryUsage().rss;
      if (finalRss > peakRss) peakRss = finalRss;

      const expectedMin = Math.floor((durationMs / intervalMs) * 0.5);
      expect(emitted).toBeGreaterThanOrEqual(expectedMin);
      expect(receivedCount).toBeGreaterThanOrEqual(expectedMin);
      expect(gaps).toBe(0);
      // Gateway seqs are 1-indexed and contiguous, so the last seq equals the count.
      expect(lastSeq).toBe(receivedCount);

      const elapsedMs = Date.now() - start;
      const rssGrowth = peakRss - baselineRss;
      // eslint-disable-next-line no-console
      console.log(
        `[case28] duration=${elapsedMs}ms emitted=${emitted} received=${receivedCount} baselineRss=${baselineRss} peakRss=${peakRss} growth=${rssGrowth} growthBudget=${rssGrowthBudget}`,
      );

      expect(rssGrowth).toBeLessThan(rssGrowthBudget);
    },
    HARD_CEILING_MS + 60_000,
  );
});
