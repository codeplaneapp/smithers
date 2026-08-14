import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { schedulerTickEffect } from "../../apps/cli/src/scheduler.js";

const SOAK_ENABLED = process.env.SMITHERS_E2E_SOAK === "1";
const SMOKE_TICKS = 3;
// 120 virtual ticks × 60 s/tick = 2 simulated hours. The nightly-only soak
// exercises the real scheduler in milliseconds rather than sleeping for hours.
const SOAK_TICKS = 120;
const CRON_PERIOD_MS = 60_000;
const JOB_COUNT = 5;
const BASE_MS = Date.parse("2026-06-17T12:00:00.000Z");

type CronRow = {
  cronId: string;
  lastRunAtMs: number | null;
  nextRunAtMs: number | null;
  errorJson: string | null;
};

type Dispatch = {
  cronId: string;
  firedAtMs: number;
};

function createDbPath(): string {
  // Keep the persisted fixture inside this worktree and remove it after every
  // run so this e2e never depends on or mutates a user's Smithers database.
  return join(process.cwd(), `.case29-cron-soak-${randomUUID()}.db`);
}

function buildDb(dbPath: string): { adapter: SmithersDb; sqlite: Database } {
  const sqlite = new Database(dbPath);
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), sqlite };
}

function removeDb(dbPath: string): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

async function runSchedulerTicks(ticks: number): Promise<Dispatch[]> {
  const dbPath = createDbPath();
  const { adapter, sqlite } = buildDb(dbPath);
  const dispatches: Dispatch[] = [];

  try {
    // This is a file-backed SQLite store, not the old in-memory adapter-only
    // fixture. The scheduler reads and updates these real persisted cron rows.
    expect(existsSync(dbPath)).toBe(true);

    for (let i = 0; i < JOB_COUNT; i++) {
      await Effect.runPromise(
        adapter.upsertCron({
          cronId: `case29-job-${i}`,
          pattern: "* * * * *",
          workflowPath: `workflows/case29-job-${i}.tsx`,
          enabled: true,
          createdAtMs: BASE_MS,
          lastRunAtMs: null,
          nextRunAtMs: BASE_MS,
          errorJson: null,
        }),
      );
    }

    for (let tick = 0; tick < ticks; tick++) {
      const virtualNow = BASE_MS + tick * CRON_PERIOD_MS;
      const tickOptions = {
        now: () => virtualNow,
        // Do not detach hundreds of real CLI runs during a virtual-time soak.
        // This only observes the process-launch edge; due selection, cron-parser
        // next-fire calculation, and persisted advancement all remain the real
        // schedulerTickEffect/processCronEffect production path.
        launchCronWorkflow: (job: { cronId: string }) => {
          dispatches.push({ cronId: job.cronId, firedAtMs: virtualNow });
        },
      };

      await Effect.runPromise(schedulerTickEffect(adapter, tickOptions));

      const afterFirstTick = (await Effect.runPromise(
        adapter.listCronsEffect(false),
      )) as CronRow[];
      expect(afterFirstTick).toHaveLength(JOB_COUNT);
      for (const cron of afterFirstTick) {
        expect(cron.lastRunAtMs).toBe(virtualNow);
        expect(cron.nextRunAtMs).toBe(virtualNow + CRON_PERIOD_MS);
        expect(cron.errorJson).toBeNull();
      }
      expect(
        afterFirstTick.filter(
          (cron) => cron.nextRunAtMs === null || cron.nextRunAtMs <= virtualNow,
        ),
      ).toHaveLength(0);

      // A repeated production tick at the same instant must see the persisted
      // nextRunAtMs and neither dispatch a duplicate nor leave a cron stuck due.
      const dispatchCountBeforeRepeat = dispatches.length;
      await Effect.runPromise(schedulerTickEffect(adapter, tickOptions));
      expect(dispatches).toHaveLength(dispatchCountBeforeRepeat);
    }

    expect(dispatches).toHaveLength(ticks * JOB_COUNT);
    expect(
      new Set(dispatches.map((dispatch) => `${dispatch.cronId}:${dispatch.firedAtMs}`)),
    ).toHaveLength(dispatches.length);
    for (let i = 0; i < JOB_COUNT; i++) {
      expect(
        dispatches.filter((dispatch) => dispatch.cronId === `case29-job-${i}`),
      ).toHaveLength(ticks);
    }

    return dispatches;
  } finally {
    sqlite.close();
    removeDb(dbPath);
  }
}

describe("case 29: Repeated cron runs over 2 hours; no stuck scheduler", () => {
  test("smoke: real scheduler advances persisted cron rows without duplicate firings", async () => {
    await runSchedulerTicks(SMOKE_TICKS);
  });

  test.skipIf(!SOAK_ENABLED)(
    "nightly soak: real scheduler has no duplicate or stuck cron firings over 120 virtual minutes",
    async () => {
      await runSchedulerTicks(SOAK_TICKS);
    },
    30_000,
  );
});
