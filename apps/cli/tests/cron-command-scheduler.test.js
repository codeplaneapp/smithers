import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";
import { launchCronWorkflow, schedulerTickEffect } from "../src/scheduler.js";

const CLI_ENTRY = resolve(import.meta.dir, "../src/index.js");

/**
 * @param {string} dbPath
 */
function openAdapter(dbPath) {
  const sqlite = new Database(dbPath);
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return {
    adapter: new SmithersDb(db),
    close: () => sqlite.close(),
  };
}

describe("smithers cron commands", () => {
  test("add, list, and rm manage persisted cron rows", async () => {
    const repo = createTempRepo();
    mkdirSync(repo.path(".smithers"));
    const { close } = openAdapter(repo.path("smithers.db"));
    close();

    const add = runSmithers(["cron", "add", "*/5 * * * *", "workflow.tsx"], {
      cwd: repo.dir,
      format: "json",
    });
    expect(add.exitCode).toBe(0);
    expect(add.json).toMatchObject({
      pattern: "*/5 * * * *",
      workflowPath: "workflow.tsx",
    });
    expect(typeof add.json?.cronId).toBe("string");

    const list = runSmithers(["cron", "list"], {
      cwd: repo.dir,
      format: "json",
    });
    expect(list.exitCode).toBe(0);
    expect(list.json?.crons).toHaveLength(1);
    expect(list.json?.crons[0]).toMatchObject({
      cronId: add.json.cronId,
      pattern: "*/5 * * * *",
      workflowPath: "workflow.tsx",
      enabled: true,
    });

    const rm = runSmithers(["cron", "rm", add.json.cronId], {
      cwd: repo.dir,
      format: "json",
    });
    expect(rm.exitCode).toBe(0);
    expect(rm.json).toMatchObject({ deleted: add.json.cronId });

    const afterRm = runSmithers(["cron", "list"], {
      cwd: repo.dir,
      format: "json",
    });
    expect(afterRm.exitCode).toBe(0);
    expect(afterRm.json).toMatchObject({ crons: [] });
  }, 30_000);

  test("cron add rejects a malformed pattern and persists nothing", async () => {
    const repo = createTempRepo();
    mkdirSync(repo.path(".smithers"));
    const { close } = openAdapter(repo.path("smithers.db"));
    close();

    const add = runSmithers(["cron", "add", "not a cron pattern", "workflow.tsx"], {
      cwd: repo.dir,
      format: "json",
    });
    expect(add.exitCode).toBe(4);
    expect(add.json?.code).toBe("INVALID_CRON_PATTERN");

    const list = runSmithers(["cron", "list"], {
      cwd: repo.dir,
      format: "json",
    });
    expect(list.exitCode).toBe(0);
    expect(list.json?.crons).toHaveLength(0);
  }, 30_000);

  test("start delegates to the scheduler entrypoint", async () => {
    const repo = createTempRepo();
    mkdirSync(repo.path(".smithers"));
    const { close } = openAdapter(repo.path("smithers.db"));
    close();

    const result = spawnSync(process.execPath, ["run", CLI_ENTRY, "cron", "start"], {
      cwd: repo.dir,
      env: process.env,
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGTERM",
    });

    expect(result.status ?? 0).toBe(0);
    expect(result.stderr + result.stdout).toContain("[smithers-cron] Starting background scheduler loop...");
  }, 30_000);
});

describe("scheduler tick effects", () => {
  test("launches a due cron workflow through the injected process boundary", () => {
    const launches = [];
    let unrefCalls = 0;

    launchCronWorkflow(
      {
        cronId: "due-cron",
        pattern: "*/5 * * * *",
        workflowPath: "due.tsx",
      },
      (command, args, options) => {
        launches.push({ command, args, options });
        return {
          unref: () => {
            unrefCalls += 1;
          },
        };
      },
    );

    expect(launches).toEqual([
      {
        command: process.execPath,
        args: [CLI_ENTRY, "up", "due.tsx", "-d"],
        options: {
          cwd: process.cwd(),
          detached: true,
          stdio: "ignore",
        },
      },
    ]);
    expect(unrefCalls).toBe(1);
  });

  test("processes due cron jobs and skips future jobs", async () => {
    const now = Date.parse("2026-06-17T12:00:00.000Z");
    const updates = [];
    const claims = [];
    const launches = [];
    const adapter = {
      listCronsEffect(enabledOnly) {
        expect(enabledOnly).toBe(true);
        return Effect.succeed([
          {
            cronId: "due-cron",
            pattern: "*/5 * * * *",
            workflowPath: "due.tsx",
            enabled: true,
            nextRunAtMs: now - 1,
          },
          {
            cronId: "future-cron",
            pattern: "*/5 * * * *",
            workflowPath: "future.tsx",
            enabled: true,
            nextRunAtMs: now + 60_000,
          },
        ]);
      },
      updateCronRunTimeEffect(cronId, lastRunAtMs, nextRunAtMs, errorJson) {
        updates.push({ cronId, lastRunAtMs, nextRunAtMs, errorJson });
        return Effect.void;
      },
      claimCronRunEffect(cronId, expectedNextRunAtMs, lastRunAtMs, nextRunAtMs) {
        claims.push({ cronId, expectedNextRunAtMs, lastRunAtMs, nextRunAtMs });
        return Effect.succeed(true);
      },
    };
    await Effect.runPromise(
      schedulerTickEffect(adapter, {
        now: () => now,
        launchCronWorkflow: (job) => launches.push(job),
      }),
    );

    expect(launches).toEqual([expect.objectContaining({ cronId: "due-cron", workflowPath: "due.tsx" })]);
    expect(updates).toHaveLength(0);
    expect(claims).toHaveLength(1);
    expect(claims[0].cronId).toBe("due-cron");
    expect(claims[0].expectedNextRunAtMs).toBe(now - 1);
    expect(claims[0].lastRunAtMs).toBe(now);
    expect(claims[0].nextRunAtMs).toBeGreaterThan(now);
  });

  test("skips launching when another scheduler already claimed the fire", async () => {
    const now = Date.parse("2026-06-17T12:00:00.000Z");
    const updates = [];
    const launches = [];
    const adapter = {
      listCronsEffect() {
        return Effect.succeed([
          {
            cronId: "contested-cron",
            pattern: "*/5 * * * *",
            workflowPath: "contested.tsx",
            enabled: true,
            nextRunAtMs: now - 1,
          },
        ]);
      },
      updateCronRunTimeEffect(cronId, lastRunAtMs, nextRunAtMs, errorJson) {
        updates.push({ cronId, lastRunAtMs, nextRunAtMs, errorJson });
        return Effect.void;
      },
      claimCronRunEffect() {
        return Effect.succeed(false);
      },
    };
    await Effect.runPromise(
      schedulerTickEffect(adapter, {
        now: () => now,
        launchCronWorkflow: (job) => launches.push(job),
      }),
    );

    expect(launches).toEqual([]);
    expect(updates).toEqual([]);
  });

  test("an invalid pattern never launches and parks a future retry", async () => {
    const now = Date.parse("2026-06-17T12:00:00.000Z");
    const updates = [];
    const launches = [];
    const adapter = {
      listCronsEffect() {
        return Effect.succeed([
          {
            cronId: "bad-cron",
            pattern: "not a cron pattern",
            workflowPath: "bad.tsx",
            enabled: true,
            nextRunAtMs: now - 1,
          },
        ]);
      },
      updateCronRunTimeEffect(cronId, lastRunAtMs, nextRunAtMs, errorJson) {
        updates.push({ cronId, lastRunAtMs, nextRunAtMs, errorJson });
        return Effect.void;
      },
      claimCronRunEffect() {
        throw new Error("should not claim when the pattern cannot be parsed");
      },
    };
    await Effect.runPromise(
      schedulerTickEffect(adapter, {
        now: () => now,
        launchCronWorkflow: (job) => launches.push(job),
      }),
    );

    expect(launches).toHaveLength(0);
    expect(updates).toEqual([
      {
        cronId: "bad-cron",
        lastRunAtMs: now,
        nextRunAtMs: now + 60_000,
        errorJson: expect.stringContaining("calculate next run for cron bad-cron"),
      },
    ]);
  });

  test("a failed launch after the claim parks a future retry", async () => {
    const now = Date.parse("2026-06-17T12:00:00.000Z");
    const updates = [];
    const adapter = {
      listCronsEffect() {
        return Effect.succeed([
          {
            cronId: "spawn-fail-cron",
            pattern: "*/5 * * * *",
            workflowPath: "fail.tsx",
            enabled: true,
            nextRunAtMs: now - 1,
          },
        ]);
      },
      updateCronRunTimeEffect(cronId, lastRunAtMs, nextRunAtMs, errorJson) {
        updates.push({ cronId, lastRunAtMs, nextRunAtMs, errorJson });
        return Effect.void;
      },
      claimCronRunEffect() {
        return Effect.succeed(true);
      },
    };
    await Effect.runPromise(
      schedulerTickEffect(adapter, {
        now: () => now,
        launchCronWorkflow: () => {
          throw new Error("spawn exploded");
        },
      }),
    );

    expect(updates).toEqual([
      {
        cronId: "spawn-fail-cron",
        lastRunAtMs: now,
        nextRunAtMs: now + 60_000,
        errorJson: expect.stringContaining("spawn cron workflow spawn-fail-cron"),
      },
    ]);
  });

  test("continues when listing crons fails", async () => {
    const launches = [];
    const adapter = {
      listCronsEffect() {
        return Effect.fail(new Error("db unavailable"));
      },
      updateCronRunTimeEffect() {
        throw new Error("should not update when list fails");
      },
    };

    await Effect.runPromise(
      schedulerTickEffect(adapter, {
        launchCronWorkflow: (job) => launches.push(job),
      }),
    );

    expect(launches).toEqual([]);
  });
});
