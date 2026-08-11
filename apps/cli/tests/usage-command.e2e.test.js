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
      outputTokens: 340,
      updatedAtMs: now,
    });
    await adapter.recordRunTokenUsage({
      runId: "usage-run",
      nodeId: "validate",
      iteration: 0,
      attempt: 1,
      inputTokens: 800,
      outputTokens: 60,
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
    outputTokens: 400,
    totalTokens: 2400,
    attempts: 2,
  });
  expect(result.stderr).toContain("2,400 tokens");
}, 30_000);
