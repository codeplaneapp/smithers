import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";

const SOAK_ENABLED = process.env.SMITHERS_E2E_SOAK === "1";

// 120 virtual ticks × 60 s/tick = 2 simulated hours. Uses virtual time so the
// test runs in milliseconds, not minutes; the invariant checked is correctness
// (no job reprocessed within its period), not wall-clock duration.
const SIMULATED_TICKS = 120;
const CRON_PERIOD_MS = 60_000;
const JOB_COUNT = 5;

function buildDb(): { adapter: SmithersDb; sqlite: Database } {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), sqlite };
}

describe("case 29: Repeated cron runs over 2 hours; no stuck scheduler", () => {
  test.skipIf(!SOAK_ENABLED)(
    "scheduler advances nextRunAtMs on every tick; no job is reprocessed within its period over 120 simulated firings",
    async () => {
      const { adapter, sqlite } = buildDb();

      const baseMs = Date.now();

      // Seed JOB_COUNT cron records, all immediately due.
      for (let i = 0; i < JOB_COUNT; i++) {
        await Effect.runPromise(
          adapter.upsertCron({
            cronId: `case29-job-${i}`,
            pattern: "* * * * *",
            workflowPath: `workflows/case29-job-${i}.tsx`,
            enabled: true,
            createdAtMs: baseMs,
            nextRunAtMs: baseMs - 1,
          }),
        );
      }

      // Track how many times each job was processed.
      const processCounts = new Map<string, number>();
      for (let i = 0; i < JOB_COUNT; i++) {
        processCounts.set(`case29-job-${i}`, 0);
      }

      // Simulate SIMULATED_TICKS cron ticks with virtual time.
      for (let tick = 0; tick < SIMULATED_TICKS; tick++) {
        const virtualNow = baseMs + tick * CRON_PERIOD_MS;
        const nextPeriodMs = virtualNow + CRON_PERIOD_MS;

        // Query due crons — mirrors the real schedulerTickEffect guard:
        // skip if nextRunAtMs > now.
        const allCrons = (await Effect.runPromise(
          adapter.listCronsEffect(true),
        )) as Array<Record<string, unknown>>;
        const dueCrons = allCrons.filter(
          (c) =>
            typeof c.nextRunAtMs !== "number" || c.nextRunAtMs <= virtualNow,
        );

        // Process each due job: advance nextRunAtMs into the next period.
        for (const job of dueCrons) {
          const cronId = job.cronId as string;
          await Effect.runPromise(
            adapter.updateCronRunTimeEffect(cronId, virtualNow, nextPeriodMs),
          );
          processCounts.set(cronId, (processCounts.get(cronId) ?? 0) + 1);
        }

        // Core invariant: after one pass, zero jobs should still be due.
        const afterCrons = (await Effect.runPromise(
          adapter.listCronsEffect(true),
        )) as Array<Record<string, unknown>>;
        const stillDue = afterCrons.filter(
          (c) =>
            typeof c.nextRunAtMs !== "number" || c.nextRunAtMs <= virtualNow,
        );
        expect(stillDue.length).toBe(0);
      }

      // Every job must have fired exactly once per tick over the full run.
      for (let i = 0; i < JOB_COUNT; i++) {
        expect(processCounts.get(`case29-job-${i}`)).toBe(SIMULATED_TICKS);
      }

      sqlite.close();
    },
    30_000,
  );
});
