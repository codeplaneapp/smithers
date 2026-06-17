import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { writeRewindAuditRow } from "../src/writeRewindAuditRow.js";
import { listRewindAuditRows } from "../src/listRewindAuditRows.js";
import { recoverInProgressRewindAudits } from "../src/recoverInProgressRewindAudits.js";

function setupDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

describe("recoverInProgressRewindAudits", () => {
  test("flips stale in_progress rows to partial and marks runs needs_attention", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      const runId = "run-recover";
      await adapter.insertRun({
        runId,
        workflowName: "wf",
        status: "running",
        createdAtMs: 1,
      });

      await writeRewindAuditRow(adapter, {
        runId,
        fromFrameNo: 5,
        toFrameNo: 2,
        caller: "user:test",
        timestampMs: 1_000,
        result: "in_progress",
        durationMs: null,
      });

      const { recovered } = await recoverInProgressRewindAudits(adapter, {
        nowMs: () => 2_500,
      });
      expect(recovered).toHaveLength(1);
      expect(recovered[0]?.runId).toBe(runId);

      const audits = await listRewindAuditRows(adapter, { runId });
      expect(audits).toHaveLength(1);
      expect(audits[0]?.result).toBe("partial");
      expect(audits[0]?.durationMs).toBe(1_500);

      const run = await adapter.getRun(runId);
      expect(run?.errorJson).toContain("needsAttention");
    } finally {
      sqlite.close();
    }
  });

  test("is a no-op when no in_progress rows exist", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      const result = await recoverInProgressRewindAudits(adapter);
      expect(result.recovered).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  test("falls back to failed status when needs_attention is rejected", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      const runId = "run-recover-fallback";
      await adapter.insertRun({
        runId,
        workflowName: "wf",
        status: "running",
        createdAtMs: 1,
      });
      await writeRewindAuditRow(adapter, {
        runId,
        fromFrameNo: 5,
        toFrameNo: 2,
        caller: "user:test",
        timestampMs: 1_000,
        result: "in_progress",
        durationMs: null,
      });

      const updateStatuses: string[] = [];
      const fallbackAdapter = {
        ...adapter,
        updateRun(id: string, patch: Record<string, unknown>) {
          updateStatuses.push(String(patch.status));
          if (patch.status === "needs_attention") {
            throw new Error("status rejected");
          }
          return adapter.updateRun(id, patch);
        },
      } as typeof adapter;

      const { recovered } = await recoverInProgressRewindAudits(fallbackAdapter, {
        nowMs: () => 2_500,
      });

      expect(recovered).toEqual([{ id: 1, runId }]);
      expect(updateStatuses).toEqual(["needs_attention", "failed"]);
      const run = await adapter.getRun(runId);
      expect(run?.status).toBe("failed");
      expect(run?.errorJson).toContain("Rewind was in_progress at startup");
    } finally {
      sqlite.close();
    }
  });

  test("still recovers the audit row when both run-status updates fail", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      const runId = "run-recover-deleted";
      await adapter.insertRun({
        runId,
        workflowName: "wf",
        status: "running",
        createdAtMs: 1,
      });
      await writeRewindAuditRow(adapter, {
        runId,
        fromFrameNo: 5,
        toFrameNo: 2,
        caller: "user:test",
        timestampMs: 1_000,
        result: "in_progress",
        durationMs: null,
      });

      const updateStatuses: string[] = [];
      const fallbackAdapter = {
        ...adapter,
        updateRun(_id: string, patch: Record<string, unknown>) {
          updateStatuses.push(String(patch.status));
          throw new Error("run row unavailable");
        },
      } as typeof adapter;

      const { recovered } = await recoverInProgressRewindAudits(fallbackAdapter, {
        nowMs: () => 2_500,
      });

      expect(recovered).toEqual([{ id: 1, runId }]);
      expect(updateStatuses).toEqual(["needs_attention", "failed"]);
      const audits = await listRewindAuditRows(adapter, { runId });
      expect(audits[0]).toMatchObject({
        id: 1,
        result: "partial",
        durationMs: 1_500,
      });
    } finally {
      sqlite.close();
    }
  });
});
