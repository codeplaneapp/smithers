import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

test("smithers usage prints a table to stderr and JSON reports to stdout", () => {
  const repo = createTempRepo();
  const smithersHome = repo.path(".smithers-home");
  mkdirSync(smithersHome, { recursive: true });
  writeFileSync(
    join(smithersHome, "accounts.json"),
    JSON.stringify(
      {
        version: 1,
        accounts: [
          {
            label: "kimi-main",
            provider: "kimi",
            configDir: "/tmp/kimi-main",
            addedAt: "2026-06-03T00:00:00.000Z",
          },
          {
            label: "openai-main",
            provider: "openai-api",
            apiKey: "",
            addedAt: "2026-06-03T00:00:00.000Z",
          },
        ],
      },
      null,
      2,
    ),
  );

  const result = runSmithers(["usage", "--account", "kimi-main"], {
    cwd: repo.dir,
    format: "json",
    env: { SMITHERS_HOME: smithersHome },
  });

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("ACCOUNT");
  expect(result.stderr).toContain("kimi-main");
  expect(result.stderr).toContain("No Kimi OAuth credentials in configDir/credentials/kimi-code.json");
  expect(result.stdout).toContain('"reports"');
  expect(result.json?.reports).toMatchObject([
    {
      accountLabel: "kimi-main",
      provider: "kimi",
      source: "none",
      error: "No Kimi OAuth credentials in configDir/credentials/kimi-code.json",
    },
  ]);
}, 30_000);

test("smithers usage --run reports a run's persisted token total (#1464 AWF-6)", async () => {
  const repo = createTempRepo();
  // Seed `_smithers_run_usage` directly: the point of the table is that a run
  // total is readable without replaying the event log, so the fixture writes
  // no TokenUsageReported events at all.
  const { Database } = await import("bun:sqlite");
  const { drizzle } = await import("drizzle-orm/bun-sqlite");
  const { SmithersDb } = await import("@smthrs/db/adapter");
  const { ensureSmithersTables } = await import("@smthrs/db/ensure");
  const sqlite = new Database(repo.path("smithers.db"));
  try {
    const adapter = new SmithersDb(drizzle(sqlite));
    ensureSmithersTables(drizzle(sqlite));
    const now = Date.now();
    await adapter.insertRun({ runId: "usage-run", workflowName: "wf", status: "finished", createdAtMs: now });
    await adapter.recordRunTokenUsage({
      runId: "usage-run",
      nodeId: "implement",
      iteration: 0,
      attempt: 1,
      inputTokens: 1200,
      freshInputTokens: 200,
      outputTokens: 340,
      cacheReadTokens: 900,
      cacheWriteTokens: 100,
      costUsd: 0.012,
      updatedAtMs: now,
    });
    await adapter.recordRunTokenUsage({
      runId: "usage-run",
      nodeId: "validate",
      iteration: 0,
      attempt: 1,
      inputTokens: 800,
      freshInputTokens: 150,
      outputTokens: 60,
      cacheReadTokens: 600,
      cacheWriteTokens: 50,
      costUsd: 0.008,
      updatedAtMs: now,
    });
  } finally {
    sqlite.close();
  }

  const result = runSmithers(["usage", "--run", "usage-run"], { cwd: repo.dir, format: "json" });

  expect(result.exitCode).toBe(0);
  expect(result.json?.usage).toMatchObject({
    runId: "usage-run",
    inputTokens: 2000,
    freshInputTokens: 350,
    outputTokens: 400,
    cacheReadTokens: 1500,
    cacheWriteTokens: 150,
    totalTokens: 2400,
    costUsd: 0.02,
    pricedAttempts: 2,
    attempts: 2,
  });
  expect(result.stderr).toContain("2,400 tokens");
  expect(result.stderr).toContain("350 fresh / 1,500 cache read / 150 cache write / 400 out");
  expect(result.stderr).toContain("~$0.0200");
}, 30_000);

test("smithers usage --run rejects an unknown run instead of reporting zero (#1464 AWF-6)", async () => {
  const repo = createTempRepo();
  // A run that spent no tokens and a run ID that never existed both SUM to
  // zero. Reporting "0 tokens" for a typo'd ID answers a question the CLI
  // cannot actually answer, so the miss has to be an error.
  const { Database } = await import("bun:sqlite");
  const { drizzle } = await import("drizzle-orm/bun-sqlite");
  const { SmithersDb } = await import("@smthrs/db/adapter");
  const { ensureSmithersTables } = await import("@smthrs/db/ensure");
  const sqlite = new Database(repo.path("smithers.db"));
  try {
    const adapter = new SmithersDb(drizzle(sqlite));
    ensureSmithersTables(drizzle(sqlite));
    await adapter.insertRun({
      runId: "spent-nothing",
      workflowName: "wf",
      status: "finished",
      createdAtMs: Date.now(),
    });
  } finally {
    sqlite.close();
  }

  const missing = runSmithers(["usage", "--run", "never-existed"], { cwd: repo.dir, format: "json" });
  expect(missing.exitCode).toBe(4);
  expect(missing.json?.code).toBe("RUN_NOT_FOUND");

  // A real run that reported no usage still reports zero, and still succeeds.
  const quiet = runSmithers(["usage", "--run", "spent-nothing"], { cwd: repo.dir, format: "json" });
  expect(quiet.exitCode).toBe(0);
  expect(quiet.json?.usage).toMatchObject({ runId: "spent-nothing", totalTokens: 0, attempts: 0 });
}, 30_000);
