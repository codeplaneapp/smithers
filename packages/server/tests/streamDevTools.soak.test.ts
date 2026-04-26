import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeXml } from "@smithers-orchestrator/graph/utils/xml";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { streamDevToolsRoute } from "../src/gatewayRoutes/streamDevTools.js";

const soakEnabled = process.env.SMITHERS_SOAK === "1";
const soakTest = soakEnabled ? test : test.skip;
const soakDurationMs = Number(process.env.SMITHERS_SOAK_MS ?? 3_600_000);
const soakDisconnectEveryMs = Number(process.env.SMITHERS_SOAK_DISCONNECT_MS ?? 30_000);

function now() {
  return Date.now();
}

describe("streamDevTools soak (opt-in)", () => {
  soakTest(
    "streams sustained events with no ordering regressions",
    async () => {
    const dbPath = join(
      tmpdir(),
      `smithers-stream-devtools-soak-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    const sqlite = new Database(dbPath);
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    const runId = "run-soak";
    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "running",
      createdAtMs: now(),
    });
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: now(),
      xmlJson: canonicalizeXml({
        kind: "element",
        tag: "smithers:workflow",
        props: { name: "soak" },
        children: [],
      }),
      xmlHash: "hash-0",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "seed",
    });

    const durationMs = soakDurationMs;
    const subscribers = 5;
    const receivedSeqs = Array.from({ length: subscribers }, () => [] as number[]);
    const baselineRss = process.memoryUsage().rss;

    let frameNo = 1;
    let stopped = false;
    const writer = (async () => {
      while (!stopped) {
        await adapter.insertFrame({
          runId,
          frameNo,
          createdAtMs: now(),
          xmlJson: canonicalizeXml({
            kind: "element",
            tag: "smithers:workflow",
            props: { name: "soak" },
            children: [
              {
                kind: "element",
                tag: "smithers:task",
                props: { id: `task-${frameNo}::0` },
                children: [],
              },
            ],
          }),
          xmlHash: `hash-${frameNo}`,
          mountedTaskIdsJson: "[]",
          taskIndexJson: "[]",
          note: "soak",
        });
        frameNo += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();

    const controllers = new Set<AbortController>();
    const readers = Array.from({ length: subscribers }, (_, index) =>
      (async () => {
        let afterSeq = 0;
        while (!stopped) {
          const controller = new AbortController();
          controllers.add(controller);
          const disconnect = setTimeout(() => controller.abort(), soakDisconnectEveryMs);
          const iterator = streamDevToolsRoute({
            adapter,
            runId,
            fromSeq: afterSeq,
            pollIntervalMs: 10,
            signal: controller.signal,
          })[Symbol.asyncIterator]();
          try {
            while (!stopped) {
              const next = await iterator.next();
              if (next.done) break;
              const seq =
                next.value.kind === "snapshot"
                  ? next.value.snapshot.seq
                  : next.value.delta.seq;
              receivedSeqs[index].push(seq);
              afterSeq = Math.max(afterSeq, seq);
            }
          } finally {
            clearTimeout(disconnect);
            controller.abort();
            controllers.delete(controller);
          }
        }
      })(),
    );

    await new Promise((resolve) => setTimeout(resolve, durationMs));
    stopped = true;
    for (const controller of controllers) {
      controller.abort();
    }
    await writer;
    await Promise.allSettled(readers);

    for (const seqs of receivedSeqs) {
      expect(seqs.length).toBeGreaterThan(0);
      const seen = new Set(seqs);
      const maxSeq = Math.max(...seqs);
      for (let seq = 0; seq <= maxSeq; seq += 1) {
        expect(seen.has(seq)).toBe(true);
      }
    }

    const rssGrowthMb = (process.memoryUsage().rss - baselineRss) / (1024 * 1024);
    expect(rssGrowthMb).toBeLessThan(50);
    sqlite.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    },
    soakDurationMs + 20_000,
  );
});
