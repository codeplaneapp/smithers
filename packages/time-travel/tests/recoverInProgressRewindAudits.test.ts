import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const tempDirs: string[] = [];

function setupFileDb() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-rewind-recovery-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "smithers.db");
  const firstSqlite = new Database(dbPath, { create: true });
  ensureSmithersTables(drizzle(firstSqlite));
  const secondSqlite = new Database(dbPath);
  return {
    firstSqlite,
    secondSqlite,
    first: new SmithersDb(drizzle(firstSqlite)),
    second: new SmithersDb(drizzle(secondSqlite)),
  };
}

async function seedAudit(
  adapter: SmithersDb,
  runId: string,
  timestampMs: number,
  result: "in_progress" | "success" | "failed" | "partial" = "in_progress",
  durationMs: number | null = null,
) {
  await adapter.insertRun({ runId, workflowName: "wf", status: "running", createdAtMs: 1 });
  return await writeRewindAuditRow(adapter, {
    runId,
    fromFrameNo: 5,
    toFrameNo: 2,
    caller: "user:test",
    timestampMs,
    result,
    durationMs,
  });
}

async function seedLease(adapter: SmithersDb, runId: string, expiresAtMs: number, owner = "owner") {
  await adapter.internalStorage.execute(
    `INSERT INTO _smithers_rewind_leases (run_id, owner_token, expires_at_ms)
     VALUES (?, ?, ?)`,
    [runId, owner, expiresAtMs],
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    // Windows holds EBUSY on just-closed sqlite dirs past any sane backoff;
    // leaking a temp dir on an ephemeral runner must not fail the suite.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // best-effort temp cleanup
    }
  }
});

describe("recoverInProgressRewindAudits", () => {
  test("does not recover a fresh audit protected by a live lease from another connection", async () => {
    const { firstSqlite, secondSqlite, first, second } = setupFileDb();
    const now = 100_000;
    try {
      const runId = "run-live-rewind";
      await first.insertRun({ runId, workflowName: "wf", status: "running", createdAtMs: 1 });
      await writeRewindAuditRow(first, {
        runId,
        fromFrameNo: 5,
        toFrameNo: 2,
        caller: "user:test",
        timestampMs: now - 1,
        result: "in_progress",
        durationMs: null,
      });
      await first.internalStorage.execute(
        `INSERT INTO _smithers_rewind_leases (run_id, owner_token, expires_at_ms)
         VALUES (?, ?, ?)`,
        [runId, "active-owner", now + 60_000],
      );

      expect(await recoverInProgressRewindAudits(second, { nowMs: () => now })).toEqual({ recovered: [] });
      expect((await listRewindAuditRows(first, { runId }))[0]?.result).toBe("in_progress");
      expect((await first.getRun(runId))?.status).toBe("running");
    } finally {
      secondSqlite.close();
      firstSqlite.close();
    }
  });

  test("leaves fresh and future audits untouched without a lease", async () => {
    const { firstSqlite, secondSqlite, first, second } = setupFileDb();
    const now = 500_000;
    try {
      await seedAudit(first, "run-fresh", now - 1);
      await seedAudit(first, "run-future", now + 1);

      expect(await recoverInProgressRewindAudits(second, { nowMs: () => now })).toEqual({ recovered: [] });
      expect((await listRewindAuditRows(first, { runId: "run-fresh" }))[0]?.result).toBe("in_progress");
      expect((await listRewindAuditRows(first, { runId: "run-future" }))[0]?.result).toBe("in_progress");
      expect((await first.getRun("run-fresh"))?.status).toBe("running");
      expect((await first.getRun("run-future"))?.status).toBe("running");
    } finally {
      secondSqlite.close();
      firstSqlite.close();
    }
  });

  test("leaves old audits protected by live and renewed leases untouched", async () => {
    const { firstSqlite, secondSqlite, first, second } = setupFileDb();
    const now = 500_000;
    try {
      await seedAudit(first, "run-live", now - 10_000);
      await seedAudit(first, "run-renewed", now - 10_000);
      await seedLease(first, "run-live", now + 1, "live-owner");
      await seedLease(first, "run-renewed", now - 1, "renewed-owner");
      await first.internalStorage.execute(
        `UPDATE _smithers_rewind_leases
            SET expires_at_ms = ?
          WHERE run_id = ? AND owner_token = ?`,
        [now + 60_000, "run-renewed", "renewed-owner"],
      );

      expect(await recoverInProgressRewindAudits(second, {
        nowMs: () => now,
        staleAfterMs: 1_000,
      })).toEqual({ recovered: [] });
      expect((await listRewindAuditRows(first, { runId: "run-live" }))[0]?.result).toBe("in_progress");
      expect((await listRewindAuditRows(first, { runId: "run-renewed" }))[0]?.result).toBe("in_progress");
    } finally {
      secondSqlite.close();
      firstSqlite.close();
    }
  });

  test("recovers cutoff-old audits with expired or absent leases", async () => {
    const { firstSqlite, secondSqlite, first, second } = setupFileDb();
    const now = 500_000;
    try {
      const expiredId = await seedAudit(first, "run-expired", now - 1_000);
      const absentId = await seedAudit(first, "run-no-lease", now - 2_000);
      await seedLease(first, "run-expired", now, "expired-owner");

      const result = await recoverInProgressRewindAudits(second, {
        nowMs: () => now,
        staleAfterMs: 1_000,
      });

      expect(result.recovered).toEqual([
        { id: expiredId as number, runId: "run-expired" },
        { id: absentId as number, runId: "run-no-lease" },
      ]);
      expect((await listRewindAuditRows(first, { runId: "run-expired" }))[0]).toMatchObject({
        result: "partial",
        durationMs: 1_000,
      });
      expect((await listRewindAuditRows(first, { runId: "run-no-lease" }))[0]).toMatchObject({
        result: "partial",
        durationMs: 2_000,
      });
      expect((await first.getRun("run-expired"))?.status).toBe("failed");
      expect((await first.getRun("run-no-lease"))?.status).toBe("failed");
    } finally {
      secondSqlite.close();
      firstSqlite.close();
    }
  });

  test("two independent recovery callers claim one audit once", async () => {
    const { firstSqlite, secondSqlite, first, second } = setupFileDb();
    const now = 500_000;
    try {
      const id = await seedAudit(first, "run-concurrent", now - 10_000);
      const [left, right] = await Promise.all([
        recoverInProgressRewindAudits(first, { nowMs: () => now, staleAfterMs: 0 }),
        recoverInProgressRewindAudits(second, { nowMs: () => now, staleAfterMs: 0 }),
      ]);

      expect([...left.recovered, ...right.recovered]).toEqual([
        { id: id as number, runId: "run-concurrent" },
      ]);
      expect((await listRewindAuditRows(first, { runId: "run-concurrent" }))[0]?.result).toBe("partial");
    } finally {
      secondSqlite.close();
      firstSqlite.close();
    }
  });

  test("a lease acquired after the audit claim fences the run mutation", async () => {
    const { firstSqlite, secondSqlite, first, second } = setupFileDb();
    const now = 500_000;
    try {
      const id = await seedAudit(first, "run-boundary-lease", now - 10_000);
      const originalQueryAllRaw = second.internalStorage.queryAllRaw.bind(second.internalStorage);
      let insertedLease = false;
      second.internalStorage.queryAllRaw = (async (statement, params = []) => {
        const rows = await originalQueryAllRaw(statement, params);
        if (!insertedLease && /^\s*UPDATE _smithers_time_travel_audit\b/.test(statement)) {
          insertedLease = true;
          await seedLease(first, "run-boundary-lease", now + 60_000, "boundary-owner");
        }
        return rows;
      }) as typeof second.internalStorage.queryAllRaw;

      expect(await recoverInProgressRewindAudits(second, {
        nowMs: () => now,
        staleAfterMs: 0,
      })).toEqual({ recovered: [{ id: id as number, runId: "run-boundary-lease" }] });
      expect(insertedLease).toBe(true);
      expect((await listRewindAuditRows(first, { runId: "run-boundary-lease" }))[0]?.result).toBe("partial");
      expect((await first.getRun("run-boundary-lease"))?.status).toBe("running");
    } finally {
      secondSqlite.close();
      firstSqlite.close();
    }
  });

  test("does not overwrite a terminal audit", async () => {
    const { firstSqlite, secondSqlite, first, second } = setupFileDb();
    try {
      await seedAudit(first, "run-terminal", 1_000, "success", 77);
      expect(await recoverInProgressRewindAudits(second, {
        nowMs: () => 500_000,
        staleAfterMs: 0,
      })).toEqual({ recovered: [] });
      expect((await listRewindAuditRows(first, { runId: "run-terminal" }))[0]).toMatchObject({
        result: "success",
        durationMs: 77,
      });
      expect((await first.getRun("run-terminal"))?.status).toBe("running");
    } finally {
      secondSqlite.close();
      firstSqlite.close();
    }
  });

  test("rejects invalid staleAfterMs values", async () => {
    const { firstSqlite, secondSqlite, second } = setupFileDb();
    try {
      for (const staleAfterMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(recoverInProgressRewindAudits(second, { staleAfterMs })).rejects.toThrow(
          "staleAfterMs must be a non-negative finite number",
        );
      }
    } finally {
      secondSqlite.close();
      firstSqlite.close();
    }
  });

  test("flips stale in_progress rows to partial and flags runs for attention", async () => {
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
        staleAfterMs: 0,
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

  test("marks the run failed with a needsAttention payload", async () => {
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

      const { recovered } = await recoverInProgressRewindAudits(adapter, {
        nowMs: () => 2_500,
        staleAfterMs: 0,
      });

      expect(recovered).toEqual([{ id: 1, runId }]);
      const run = await adapter.getRun(runId);
      expect(run?.status).toBe("failed");
      expect(run?.errorJson).toContain("needsAttention");
      expect(run?.errorJson).toContain("Rewind was in_progress at startup");
    } finally {
      sqlite.close();
    }
  });

  test("preserves duration and recovers best-effort when the run row was deleted", async () => {
    const { firstSqlite, secondSqlite, first, second } = setupFileDb();
    try {
      const runId = "run-recover-deleted";
      await seedAudit(first, runId, 1_000, "in_progress", 77);
      firstSqlite.run("PRAGMA foreign_keys = OFF");
      firstSqlite.query("DELETE FROM _smithers_runs WHERE run_id = ?").run(runId);

      const { recovered } = await recoverInProgressRewindAudits(second, {
        nowMs: () => 2_500,
        staleAfterMs: 0,
      });

      expect(recovered).toEqual([{ id: 1, runId }]);
      const audits = await listRewindAuditRows(first, { runId });
      expect(audits[0]).toMatchObject({
        id: 1,
        result: "partial",
        durationMs: 77,
      });
      expect(await second.getRun(runId)).toBeUndefined();
    } finally {
      secondSqlite.close();
      firstSqlite.close();
    }
  });
});
