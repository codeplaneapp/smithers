import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { writeRewindAuditRow } from "../src/writeRewindAuditRow.js";
import { listRewindAuditRows } from "../src/listRewindAuditRows.js";
import { recoverRewindAuditsAtStartup } from "../src/recoverRewindAuditsAtStartup.js";

function setupDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

describe("recoverRewindAuditsAtStartup", () => {
  test("recovers a crash-interrupted rewind and reports the count", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      const runId = "run-startup-recover";
      await adapter.insertRun({ runId, workflowName: "wf", status: "running", createdAtMs: 1 });
      await writeRewindAuditRow(adapter, {
        runId,
        fromFrameNo: 5,
        toFrameNo: 2,
        caller: "user:test",
        timestampMs: 1_000,
        result: "in_progress",
        durationMs: null,
      });

      let recoveredCount = 0;
      let errored = false;
      await recoverRewindAuditsAtStartup(adapter, {
        nowMs: () => 2_500,
        staleAfterMs: 0,
        onRecovered: (count) => {
          recoveredCount = count;
        },
        onError: () => {
          errored = true;
        },
      });

      expect(recoveredCount).toBe(1);
      expect(errored).toBe(false);
      const audits = await listRewindAuditRows(adapter, { runId });
      expect(audits[0]?.result).toBe("partial");
      const run = await adapter.getRun(runId);
      expect(run?.status).toBe("failed");
      expect(run?.errorJson).toContain("needsAttention");
    } finally {
      sqlite.close();
    }
  });

  test("does not call onRecovered when there is nothing to recover", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      let called = false;
      await recoverRewindAuditsAtStartup(adapter, {
        onRecovered: () => {
          called = true;
        },
      });
      expect(called).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  test("never throws and swallows the non-SQLite audit-client error", async () => {
    let errored = false;
    // A non-SQLite adapter: resolveRewindAuditClient throws a TypeError naming the
    // SQLite client; recovery has no Postgres path, so it must be swallowed.
    await expect(
      recoverRewindAuditsAtStartup({ db: {} } as unknown as SmithersDb, {
        onError: () => {
          errored = true;
        },
      }),
    ).resolves.toBeUndefined();
    expect(errored).toBe(false);
  });
});
