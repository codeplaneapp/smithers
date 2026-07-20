import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { countRecentRewindAuditRows } from "../src/countRecentRewindAuditRows.js";
import { evaluateRewindRateLimit } from "../src/evaluateRewindRateLimit.js";
import { listRewindAuditRows } from "../src/listRewindAuditRows.js";
import { updateRewindAuditRow } from "../src/updateRewindAuditRow.js";
import { writeRewindAuditRow } from "../src/writeRewindAuditRow.js";
import { expandResetSet } from "../src/fork/_helpers.js";

function setupDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

async function seedRun(adapter: SmithersDb, runId = "run-1") {
  await adapter.insertRun({
    runId,
    workflowName: "wf",
    status: "running",
    createdAtMs: 1,
  });
}

async function writeAudit(adapter: SmithersDb, overrides: Partial<Parameters<typeof writeRewindAuditRow>[1]> = {}) {
  return writeRewindAuditRow(adapter, {
    runId: "run-1",
    fromFrameNo: 5,
    toFrameNo: 2,
    caller: "user:owner",
    timestampMs: 1_000,
    result: "success",
    durationMs: 10,
    ...overrides,
  });
}

describe("rewind audit helpers", () => {
  test("counts only terminal rows for the caller and window", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter);
      await writeAudit(adapter, { timestampMs: 900, result: "success" });
      await writeAudit(adapter, { timestampMs: 950, result: "failed" });
      await writeAudit(adapter, { timestampMs: 980, result: "in_progress" });
      await writeAudit(adapter, { timestampMs: 990, caller: "user:other" });
      await writeAudit(adapter, { timestampMs: 100, result: "partial" });

      await expect(
        countRecentRewindAuditRows(adapter, {
          runId: "run-1",
          caller: "user:owner",
          sinceMs: 800,
        }),
      ).resolves.toBe(2);
    } finally {
      sqlite.close();
    }
  });

  test("evaluates quota with normalized max/window values", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter);
      await writeAudit(adapter, { timestampMs: 900 });
      await writeAudit(adapter, { timestampMs: 950 });

      const result = await evaluateRewindRateLimit({
        adapter,
        runId: "run-1",
        caller: "user:owner",
        nowMs: () => 1_000,
        maxPerWindow: 2,
        windowMs: 200,
      });

      expect(result).toEqual({
        limited: true,
        used: 2,
        remaining: 0,
        max: 2,
        windowMs: 200,
        windowStartedAtMs: 800,
      });
    } finally {
      sqlite.close();
    }
  });

  test("updates result, duration, and optional from frame", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter);
      const inserted = await writeAudit(adapter, {
        fromFrameNo: 8,
        result: "in_progress",
        durationMs: null,
      });

      await updateRewindAuditRow(adapter, {
        id: inserted ?? -1,
        result: "partial",
        durationMs: 250,
        fromFrameNo: 6,
      });

      const rows = await listRewindAuditRows(adapter, { runId: "run-1" });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: inserted,
        result: "partial",
        durationMs: 250,
        fromFrameNo: 6,
      });
    } finally {
      sqlite.close();
    }
  });
});

describe("expandResetSet", () => {
  test("falls back to exact keys when reset IDs are not base node IDs", () => {
    const nodes = {
      "task-a::0": {},
      "task-b::1": {},
    };

    expect(expandResetSet(nodes, ["task-b::1"])).toEqual(["task-b::1"]);
  });
});
