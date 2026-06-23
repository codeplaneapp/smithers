import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { loadBudget } from "../budgets/loadBudget.ts";

const SOAK_ENABLED = process.env.SMITHERS_E2E_SOAK === "1";

// Simulate a long-lived workspace session: 500 sequential run records against
// the same open DB connection. Once jjhub/0002 lands, this baseline can be
// promoted to drive a real @jjhub/smithers-runtime-workspace instead.
const RUN_COUNT = 500;
const SAMPLE_INTERVAL_MS = 5_000;

function buildDb(): { adapter: SmithersDb; sqlite: Database } {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), sqlite };
}

function tryGc(): void {
  const bunGc = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun
    ?.gc;
  if (typeof bunGc === "function") bunGc(true);
}

describe("case 30: Long-lived JJHub workspace, repeated runs; stable behavior", () => {
  test.skipIf(!SOAK_ENABLED)(
    "500 sequential run records written and read back with correct status; peak RSS within budget",
    async () => {
      const budget = (await loadBudget("memory")) as {
        longLivedRuns500: { rssBytesMax: number };
      };
      const rssBudget = budget.longLivedRuns500.rssBytesMax;

      const { adapter, sqlite } = buildDb();

      tryGc();
      const baselineRss = process.memoryUsage().rss;
      let peakRss = baselineRss;

      const sampleHandle = setInterval(() => {
        const current = process.memoryUsage().rss;
        if (current > peakRss) peakRss = current;
      }, SAMPLE_INTERVAL_MS);

      try {
        const baseMs = Date.now();

        // Phase 1: create RUN_COUNT run records (simulating workspace runs).
        for (let i = 0; i < RUN_COUNT; i++) {
          await Effect.runPromise(
            adapter.insertRun({
              runId: `case30-run-${i}`,
              workflowName: "case30-workspace-run",
              status: "running",
              createdAtMs: baseMs + i,
            }),
          );
        }

        // Phase 2: mark each run finished (simulating completion).
        for (let i = 0; i < RUN_COUNT; i++) {
          await Effect.runPromise(
            adapter.updateRun(`case30-run-${i}`, {
              status: "finished",
              finishedAtMs: baseMs + i + 1,
            }),
          );
        }

        // Phase 3: read back every run and assert data integrity.
        for (let i = 0; i < RUN_COUNT; i++) {
          const run = (await Effect.runPromise(
            adapter.getRun(`case30-run-${i}`),
          )) as Record<string, unknown> | undefined;
          expect(run?.runId).toBe(`case30-run-${i}`);
          expect(run?.status).toBe("finished");
        }

        tryGc();
        const finalRss = process.memoryUsage().rss;
        if (finalRss > peakRss) peakRss = finalRss;

        console.log(
          `[case30] runs=${RUN_COUNT} baselineRss=${baselineRss} peakRss=${peakRss} budget=${rssBudget}`,
        );

        expect(peakRss).toBeLessThan(rssBudget);
      } finally {
        clearInterval(sampleHandle);
        sqlite.close();
      }
    },
    120_000,
  );
});
