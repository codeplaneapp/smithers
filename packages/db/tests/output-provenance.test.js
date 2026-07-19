import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { ensureSmithersTables } from "../src/ensure.js";
import { SmithersDb } from "../src/adapter.js";
import { loadOutputs } from "../src/snapshot.js";

const outputs = sqliteTable("provenance_output", {
  runId: text("run_id").notNull(), nodeId: text("node_id").notNull(),
  iteration: integer("iteration").notNull(), value: integer("value"), seq: integer("seq"),
});

function open(path) {
  const sqlite = new Database(path);
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS provenance_output (run_id TEXT NOT NULL, node_id TEXT NOT NULL, iteration INTEGER NOT NULL, value INTEGER, seq INTEGER, PRIMARY KEY (run_id, node_id, iteration))");
  return { sqlite, db, adapter: new SmithersDb(db) };
}

describe("durable output completion provenance", () => {
  test("allocates unique completion order for concurrent writers and preserves user seq", async () => {
    const { sqlite, adapter, db } = open(":memory:");
    try {
      await adapter.insertRun({ runId: "r", workflowName: "wf", status: "running", createdAtMs: 1 });
      await Promise.all([1, 2, 3].map((value, i) => adapter.upsertOutputRow(outputs, { runId: "r", nodeId: `n${i}`, iteration: 0 }, { value, seq: 900 + value })));
      const provenance = sqlite.query("SELECT node_id, seq FROM _smithers_output_provenance WHERE run_id = ? ORDER BY seq").all("r");
      expect(provenance).toHaveLength(3);
      expect(new Set(provenance.map((row) => row.seq)).size).toBe(3);
      const rows = await loadOutputs(db, { outputs }, "r");
      expect(rows.provenance_output.map((row) => row.seq)).toEqual([901, 902, 903]);
    } finally { sqlite.close(); }
  });

  test("survives close and resume without changing row order", async () => {
    const path = join(tmpdir(), `smithers-provenance-${randomUUID()}.db`);
    const first = open(path);
    await first.adapter.insertRun({ runId: "resume", workflowName: "wf", status: "running", createdAtMs: 1 });
    await first.adapter.upsertOutputRow(outputs, { runId: "resume", nodeId: "b", iteration: 0 }, { value: 2 });
    await first.adapter.upsertOutputRow(outputs, { runId: "resume", nodeId: "a", iteration: 0 }, { value: 1 });
    const before = first.sqlite.query("SELECT node_id, seq FROM _smithers_output_provenance WHERE run_id = ? ORDER BY seq").all("resume");
    first.sqlite.close();
    const second = open(path);
    try {
      const after = second.sqlite.query("SELECT node_id, seq FROM _smithers_output_provenance WHERE run_id = ? ORDER BY seq").all("resume");
      expect(after).toEqual(before);
    } finally { second.sqlite.close(); }
  });

  test("output row and provenance commit atomically when the provenance write crashes", async () => {
    const { sqlite, adapter } = open(":memory:");
    try {
      await adapter.insertRun({ runId: "atomic", workflowName: "wf", status: "running", createdAtMs: 1 });
      const originalExecute = adapter.internalStorage.execute.bind(adapter.internalStorage);
      adapter.internalStorage.execute = (sql, params) => {
        if (String(sql).includes("INSERT INTO _smithers_output_provenance")) {
          throw new Error("injected crash between output write and provenance write");
        }
        return originalExecute(sql, params);
      };
      let crashError;
      try {
        await adapter.upsertOutputRow(outputs, { runId: "atomic", nodeId: "task", iteration: 0 }, { value: 1 });
      } catch (error) {
        crashError = error;
      }
      expect(String(crashError)).toContain("injected crash");
      // Neither: the transaction must have rolled back the output row too.
      expect(sqlite.query("SELECT * FROM provenance_output WHERE run_id = ?").all("atomic")).toHaveLength(0);
      expect(sqlite.query("SELECT * FROM _smithers_output_provenance WHERE run_id = ?").all("atomic")).toHaveLength(0);
      // Both: with the fault removed, the same upsert commits both writes.
      adapter.internalStorage.execute = originalExecute;
      await adapter.upsertOutputRow(outputs, { runId: "atomic", nodeId: "task", iteration: 0 }, { value: 1 });
      expect(sqlite.query("SELECT value FROM provenance_output WHERE run_id = ?").all("atomic")).toEqual([{ value: 1 }]);
      expect(sqlite.query("SELECT seq FROM _smithers_output_provenance WHERE run_id = ?").all("atomic")).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  test("signals and outputs allocate unique seqs from one shared clock under concurrent delivery, stable across resume", async () => {
    // The machine fold's total order (provenance seq, declaration index,
    // mapped subindex) is deterministic only if seq is genuinely unique
    // across BOTH allocation spaces. Race three signal deliveries against
    // three output upserts on one run, then prove uniqueness across the
    // union and that the order survives a close/reopen unchanged.
    const path = join(tmpdir(), `smithers-shared-clock-${randomUUID()}.db`);
    const first = open(path);
    await first.adapter.insertRun({ runId: "clock", workflowName: "wf", status: "running", createdAtMs: 1 });
    await Promise.all([
      ...[0, 1, 2].map((i) => first.adapter.upsertOutputRow(outputs, { runId: "clock", nodeId: `task${i}`, iteration: 0 }, { value: i })),
      ...[0, 1, 2].map((i) => Effect.runPromise(first.adapter.insertSignalWithNextSeq({
        runId: "clock",
        signalName: "PING",
        correlationId: `c${i}`,
        payloadJson: JSON.stringify({ i }),
        receivedAtMs: 1000 + i,
        receivedBy: null,
      }))),
    ]);
    const readUnion = (sqlite) => sqlite.query(
      `SELECT seq, src, key FROM (
         SELECT seq, 'output' AS src, node_id AS key FROM _smithers_output_provenance WHERE run_id = 'clock'
         UNION ALL
         SELECT seq, 'signal' AS src, correlation_id AS key FROM _smithers_signals WHERE run_id = 'clock'
       ) ORDER BY seq`,
    ).all();
    const before = readUnion(first.sqlite);
    first.sqlite.close();
    expect(before).toHaveLength(6);
    expect(new Set(before.map((row) => row.seq)).size).toBe(6);
    expect(before.filter((row) => row.src === "signal")).toHaveLength(3);
    const second = open(path);
    try {
      expect(readUnion(second.sqlite)).toEqual(before);
    } finally { second.sqlite.close(); }
  });

  test("same-key replacement retains its original completion sequence", async () => {
    const { sqlite, adapter, db } = open(":memory:");
    try {
      await adapter.insertRun({ runId: "replace", workflowName: "wf", status: "running", createdAtMs: 1 });
      await adapter.upsertOutputRow(outputs, { runId: "replace", nodeId: "task", iteration: 0 }, { value: 1, seq: 700 });
      await adapter.upsertOutputRow(outputs, { runId: "replace", nodeId: "task", iteration: 0 }, { value: 2, seq: 701 });
      expect(sqlite.query("SELECT seq FROM _smithers_output_provenance WHERE run_id = ? AND node_id = ?").get("replace", "task").seq).toBe(0);
      const rows = await loadOutputs(db, { outputs }, "replace");
      expect(rows.provenance_output[0]).toMatchObject({ value: 2, seq: 701, __smithersProvenanceSeq: 0 });
    } finally { sqlite.close(); }
  });
});
