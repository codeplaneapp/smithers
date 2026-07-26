import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SqlMessageStorage } from "../src/sql-message-storage.js";
import { SmithersDb } from "../src/adapter.js";

/**
 * The "external SQLite" driver path (Cloudflare/edge descriptors) routes every
 * query through {@link createExternalSqliteConnection} instead of bun:sqlite.
 * Here it is backed by a REAL bun:sqlite Database wrapped in the external
 * descriptor interface — a real backend, not a mock — so the external code path
 * runs against genuine SQLite behaviour.
 * @param {{ withExecute?: boolean; withQueryValues?: boolean; withTransaction?: boolean }} [opts]
 */
function makeExternalDb({ withExecute = true, withQueryValues = true, withTransaction = true } = {}) {
  const raw = new Database(":memory:");
  /** @type {any} */
  const descriptor = {
    dialect: "sqlite",
    driver: "cloudflare-sqlite",
    queryAllRaw: async (sql, params = []) => raw.query(sql).all(...(params ?? [])),
  };
  if (withTransaction) {
    descriptor.transaction = async (op) => {
      raw.run("BEGIN IMMEDIATE");
      try {
        const result = await op();
        raw.run("COMMIT");
        return result;
      } catch (error) {
        raw.run("ROLLBACK");
        throw error;
      }
    };
  }
  if (withQueryValues) {
    descriptor.queryValuesRaw = async (sql, params = []) => raw.query(sql).values(...(params ?? []));
  }
  if (withExecute) {
    descriptor.execute = async (sql, params = []) => {
      raw.query(sql).run(...(params ?? []));
    };
  }
  return { raw, descriptor };
}

describe("SqlMessageStorage external-sqlite connection", () => {
  test("ensureSchema + full CRUD run through the external descriptor", async () => {
    const { descriptor } = makeExternalDb();
    const storage = new SqlMessageStorage(descriptor);
    expect(storage.driverKind).toBe("cloudflare-sqlite");
    await storage.ensureSchema();

    await storage.upsert("_smithers_runs", { runId: "r1", workflowName: "wf", status: "running", createdAtMs: 1 }, [
      "runId",
    ]);
    await storage.upsert("_smithers_runs", { runId: "r1", workflowName: "wf", status: "finished", createdAtMs: 1 }, [
      "runId",
    ]);
    const one = await storage.queryOne("SELECT * FROM _smithers_runs WHERE run_id = ?", ["r1"]);
    expect(one.status).toBe("finished");

    await storage.insertIgnore("_smithers_events", {
      runId: "r1",
      seq: 0,
      timestampMs: 1,
      type: "run.started",
      payloadJson: "{}",
    });
    await storage.updateWhere("_smithers_runs", { status: "cancelled" }, "run_id = ?", ["r1"]);
    expect((await storage.queryOne("SELECT status FROM _smithers_runs WHERE run_id = ?", ["r1"])).status).toBe(
      "cancelled",
    );

    const raws = await storage.queryAllRaw("SELECT run_id FROM _smithers_runs");
    expect(raws.length).toBe(1);
    await storage.deleteWhere("_smithers_events", "run_id = ?", ["r1"]);
    expect((await storage.queryAll("SELECT * FROM _smithers_events")).length).toBe(0);

    // Transaction path routes through descriptor.transaction.
    await storage.transaction(async () => {
      await storage.upsert("_smithers_runs", { runId: "r2", workflowName: "wf", status: "running", createdAtMs: 2 }, [
        "runId",
      ]);
    });
    expect((await storage.queryAll("SELECT * FROM _smithers_runs")).length).toBe(2);

    // The async initializer installs the same payload lifecycle triggers as
    // bun:sqlite even when the edge runtime owns the connection.
    await storage.execute(
      "INSERT INTO _smithers_snapshot_contents (content_hash, nodes_json, outputs_json, ralph_json, input_json, ref_count) VALUES (?, '[]', '{}', '[]', '{}', 0)",
      ["content-1"],
    );
    await storage.execute(
      "INSERT INTO _smithers_snapshots (run_id, frame_no, nodes_json, outputs_json, ralph_json, input_json, content_hash, created_at_ms) VALUES (?, 0, '', '', '', '', ?, 1)",
      ["snapshot-run", "content-1"],
    );
    await storage.execute(
      "INSERT INTO _smithers_snapshot_payload_refs (run_id, frame_no, content_hash) VALUES (?, 0, ?)",
      ["snapshot-run", "content-1"],
    );
    expect(
      (
        await storage.queryOne("SELECT ref_count FROM _smithers_snapshot_contents WHERE content_hash = ?", [
          "content-1",
        ])
      ).refCount,
    ).toBe(1);
    await storage.deleteWhere("_smithers_snapshots", "run_id = ?", ["snapshot-run"]);
    expect(
      await storage.queryOne("SELECT content_hash FROM _smithers_snapshot_contents WHERE content_hash = ?", [
        "content-1",
      ]),
    ).toBeUndefined();
  });

  test("executeRaw falls back to queryAllRaw when the descriptor has no execute()", async () => {
    const { raw, descriptor } = makeExternalDb({ withExecute: false, withQueryValues: false });
    // No descriptor.execute → schema DDL must run through the run()/queryAllRaw
    // fallback path, so create the table via the raw client, then drive writes
    // through storage.execute (routes executeRaw → run fallback).
    raw.run(
      `CREATE TABLE _smithers_runs (run_id TEXT PRIMARY KEY, workflow_name TEXT, status TEXT, created_at_ms INTEGER)`,
    );
    const storage = new SqlMessageStorage(descriptor);
    await storage.execute(
      `INSERT INTO _smithers_runs (run_id, workflow_name, status, created_at_ms) VALUES (?, ?, ?, ?)`,
      ["r1", "wf", "running", 1],
    );
    // queryValuesRaw with no descriptor.queryValuesRaw → maps queryAllRaw rows to value arrays.
    expect((await storage.queryAll("SELECT * FROM _smithers_runs")).length).toBe(1);
  });

  test("descriptor without a transaction callback fails before running the operation", async () => {
    const { raw, descriptor } = makeExternalDb({ withTransaction: false });
    const storage = new SqlMessageStorage(descriptor);
    await storage.ensureSchema();
    let ran = false;
    await expect(
      storage.transaction(async () => {
        ran = true;
        await storage.execute(
          "INSERT INTO _smithers_snapshot_contents (content_hash, nodes_json, outputs_json, ralph_json, input_json, ref_count) VALUES ('fallback-hash', '[]', '{}', '[]', '{}', 0)",
        );
      }),
    ).rejects.toThrow(/must provide an atomic transaction\(\) callback/);
    expect(ran).toBe(false);
    expect(raw.query("SELECT COUNT(*) AS count FROM _smithers_snapshot_contents").get().count).toBe(0);
    raw.close();
  });

  test("an explicitly non-transactional descriptor fails before running the operation", async () => {
    const { raw, descriptor } = makeExternalDb({ withTransaction: false });
    descriptor.supportsTransactions = false;
    const storage = new SqlMessageStorage(descriptor);
    let ran = false;
    await expect(
      storage.transaction(async () => {
        ran = true;
        await storage.execute("CREATE TABLE should_not_exist (id INTEGER)");
      }),
    ).rejects.toThrow(/does not support atomic transactions/);
    expect(ran).toBe(false);
    expect(raw.query("SELECT name FROM sqlite_master WHERE name = 'should_not_exist'").get()).toBeNull();
    raw.close();
  });
});

describe("SmithersDb over an external-sqlite descriptor", () => {
  test("claimRunForResume updates the runtime owner and heartbeat", async () => {
    const { descriptor } = makeExternalDb();
    const storage = new SqlMessageStorage(descriptor);
    await storage.ensureSchema();
    const adapter = new SmithersDb(descriptor);

    await adapter.insertRun({
      runId: "stale",
      workflowName: "wf",
      status: "running",
      createdAtMs: 1,
      runtimeOwnerId: "old-owner",
      heartbeatAtMs: 100,
    });
    const claimed = await adapter.claimRunForResume({
      runId: "stale",
      expectedRuntimeOwnerId: "old-owner",
      expectedHeartbeatAtMs: 100,
      staleBeforeMs: 200,
      claimOwnerId: "supervisor",
      claimHeartbeatAtMs: 300,
    });

    expect(claimed).toBe(true);
    const run = await adapter.getRun("stale");
    expect(run.runtimeOwnerId).toBe("supervisor");
    expect(run.heartbeatAtMs).toBe(300);
  });

  test("insert/read + getRawNodeOutput (async boolean-column lookup) + external transaction + signal fallback", async () => {
    const { raw, descriptor } = makeExternalDb();
    const storage = new SqlMessageStorage(descriptor);
    await storage.ensureSchema();
    const adapter = new SmithersDb(descriptor);

    await adapter.insertRun({ runId: "r1", workflowName: "wf", status: "running", createdAtMs: 1 });
    expect((await adapter.getRun("r1")).runId).toBe("r1");

    // Output table read via the non-bun getRawNodeOutput branch (async
    // getPersistedBooleanColumnNamesAsync over _smithers_output_schema_columns).
    raw.run(
      `CREATE TABLE out_ext (run_id TEXT NOT NULL, node_id TEXT NOT NULL, iteration INTEGER NOT NULL DEFAULT 0, ok INTEGER, PRIMARY KEY (run_id, node_id, iteration))`,
    );
    raw.run(
      `CREATE TABLE IF NOT EXISTS _smithers_output_schema_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (table_name, column_name))`,
    );
    raw.run(
      `INSERT INTO _smithers_output_schema_columns (table_name, column_name, kind) VALUES ('out_ext','ok','boolean')`,
    );
    raw.run(`INSERT INTO out_ext (run_id, node_id, iteration, ok) VALUES ('r1','n1',0,1)`);
    const output = await adapter.getRawNodeOutput("out_ext", "r1", "n1");
    expect(output.ok).toBe(true);

    // withTransactionEffect external branch (internalStorage.transaction path).
    await adapter.withTransaction(
      "ext-tx",
      adapter.insertRun({ runId: "r2", workflowName: "wf", status: "running", createdAtMs: 2 }),
    );
    expect((await adapter.getRun("r2")).runId).toBe("r2");

    // insertSignalWithNextSeq non-bun serialized fallback (read-MAX-then-insert).
    const seq0 = await adapter.insertSignalWithNextSeq({
      runId: "r1",
      signalName: "go",
      correlationId: null,
      payloadJson: "{}",
      receivedAtMs: 1,
      receivedBy: null,
    });
    expect(seq0).toBe(0);
    const seq1 = await adapter.insertSignalWithNextSeq({
      runId: "r1",
      signalName: "go",
      correlationId: "c",
      payloadJson: "{}",
      receivedAtMs: 1,
      receivedBy: null,
    });
    expect(seq1).toBe(1);
  });

  test("deleteOutputRow resolves tables through sqlite_master, not information_schema", async () => {
    const { raw, descriptor } = makeExternalDb();
    const storage = new SqlMessageStorage(descriptor);
    await storage.ensureSchema();
    const adapter = new SmithersDb(descriptor);

    raw.run(
      `CREATE TABLE out_delete (run_id TEXT NOT NULL, node_id TEXT NOT NULL, iteration INTEGER NOT NULL DEFAULT 0, ok INTEGER, PRIMARY KEY (run_id, node_id, iteration))`,
    );
    raw.run(`INSERT INTO out_delete (run_id, node_id, iteration, ok) VALUES ('r1','n1',0,1)`);
    await adapter.deleteOutputRow("out_delete", { runId: "r1", nodeId: "n1", iteration: 0 });
    expect(raw.query(`SELECT COUNT(*) AS n FROM out_delete`).get().n).toBe(0);

    // The camelCase → snake_case resolution path also probes existence.
    raw.run(`INSERT INTO out_delete (run_id, node_id, iteration, ok) VALUES ('r2','n2',0,1)`);
    await adapter.deleteOutputRow("outDelete", { runId: "r2", nodeId: "n2", iteration: 0 });
    expect(raw.query(`SELECT COUNT(*) AS n FROM out_delete`).get().n).toBe(0);
  });
});
