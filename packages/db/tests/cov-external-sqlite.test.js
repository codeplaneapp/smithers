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
 * @param {{ withExecute?: boolean; withQueryValues?: boolean }} [opts]
 */
function makeExternalDb({ withExecute = true, withQueryValues = true } = {}) {
    const raw = new Database(":memory:");
    /** @type {any} */
    const descriptor = {
        dialect: "sqlite",
        driver: "cloudflare-sqlite",
        queryAllRaw: async (sql, params = []) => raw.query(sql).all(...(params ?? [])),
        transaction: async (op) => raw.transaction(() => op())(),
    };
    if (withQueryValues) {
        descriptor.queryValuesRaw = async (sql, params = []) => raw.query(sql).values(...(params ?? []));
    }
    if (withExecute) {
        descriptor.execute = async (sql, params = []) => { raw.query(sql).run(...(params ?? [])); };
    }
    return { raw, descriptor };
}

describe("SqlMessageStorage external-sqlite connection", () => {
    test("ensureSchema + full CRUD run through the external descriptor", async () => {
        const { descriptor } = makeExternalDb();
        const storage = new SqlMessageStorage(descriptor);
        expect(storage.driverKind).toBe("cloudflare-sqlite");
        await storage.ensureSchema();

        await storage.upsert("_smithers_runs", { runId: "r1", workflowName: "wf", status: "running", createdAtMs: 1 }, ["runId"]);
        await storage.upsert("_smithers_runs", { runId: "r1", workflowName: "wf", status: "finished", createdAtMs: 1 }, ["runId"]);
        const one = await storage.queryOne("SELECT * FROM _smithers_runs WHERE run_id = ?", ["r1"]);
        expect(one.status).toBe("finished");

        await storage.insertIgnore("_smithers_events", { runId: "r1", seq: 0, timestampMs: 1, type: "run.started", payloadJson: "{}" });
        await storage.updateWhere("_smithers_runs", { status: "cancelled" }, "run_id = ?", ["r1"]);
        expect((await storage.queryOne("SELECT status FROM _smithers_runs WHERE run_id = ?", ["r1"])).status).toBe("cancelled");

        const raws = await storage.queryAllRaw("SELECT run_id FROM _smithers_runs");
        expect(raws.length).toBe(1);
        await storage.deleteWhere("_smithers_events", "run_id = ?", ["r1"]);
        expect((await storage.queryAll("SELECT * FROM _smithers_events")).length).toBe(0);

        // Transaction path routes through descriptor.transaction.
        await storage.transaction(async () => {
            await storage.upsert("_smithers_runs", { runId: "r2", workflowName: "wf", status: "running", createdAtMs: 2 }, ["runId"]);
        });
        expect((await storage.queryAll("SELECT * FROM _smithers_runs")).length).toBe(2);
    });

    test("executeRaw falls back to queryAllRaw when the descriptor has no execute()", async () => {
        const { raw, descriptor } = makeExternalDb({ withExecute: false, withQueryValues: false });
        // No descriptor.execute → schema DDL must run through the run()/queryAllRaw
        // fallback path, so create the table via the raw client, then drive writes
        // through storage.execute (routes executeRaw → run fallback).
        raw.run(`CREATE TABLE _smithers_runs (run_id TEXT PRIMARY KEY, workflow_name TEXT, status TEXT, created_at_ms INTEGER)`);
        const storage = new SqlMessageStorage(descriptor);
        await storage.execute(`INSERT INTO _smithers_runs (run_id, workflow_name, status, created_at_ms) VALUES (?, ?, ?, ?)`, ["r1", "wf", "running", 1]);
        // queryValuesRaw with no descriptor.queryValuesRaw → maps queryAllRaw rows to value arrays.
        expect((await storage.queryAll("SELECT * FROM _smithers_runs")).length).toBe(1);
    });
});

describe("SmithersDb over an external-sqlite descriptor", () => {
    test("insert/read + getRawNodeOutput (async boolean-column lookup) + external transaction + signal fallback", async () => {
        const { raw, descriptor } = makeExternalDb();
        const storage = new SqlMessageStorage(descriptor);
        await storage.ensureSchema();
        const adapter = new SmithersDb(descriptor);

        await adapter.insertRun({ runId: "r1", workflowName: "wf", status: "running", createdAtMs: 1 });
        expect((await adapter.getRun("r1")).runId).toBe("r1");

        // Output table read via the non-bun getRawNodeOutput branch (async
        // getPersistedBooleanColumnNamesAsync over _smithers_output_schema_columns).
        raw.run(`CREATE TABLE out_ext (run_id TEXT NOT NULL, node_id TEXT NOT NULL, iteration INTEGER NOT NULL DEFAULT 0, ok INTEGER, PRIMARY KEY (run_id, node_id, iteration))`);
        raw.run(`CREATE TABLE IF NOT EXISTS _smithers_output_schema_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (table_name, column_name))`);
        raw.run(`INSERT INTO _smithers_output_schema_columns (table_name, column_name, kind) VALUES ('out_ext','ok','boolean')`);
        raw.run(`INSERT INTO out_ext (run_id, node_id, iteration, ok) VALUES ('r1','n1',0,1)`);
        const output = await adapter.getRawNodeOutput("out_ext", "r1", "n1");
        expect(output.ok).toBe(true);

        // withTransactionEffect external branch (internalStorage.transaction path).
        await adapter.withTransaction("ext-tx", adapter.insertRun({ runId: "r2", workflowName: "wf", status: "running", createdAtMs: 2 }));
        expect((await adapter.getRun("r2")).runId).toBe("r2");

        // insertSignalWithNextSeq non-bun serialized fallback (read-MAX-then-insert).
        const seq0 = await adapter.insertSignalWithNextSeq({ runId: "r1", signalName: "go", correlationId: null, payloadJson: "{}", receivedAtMs: 1, receivedBy: null });
        expect(seq0).toBe(0);
        const seq1 = await adapter.insertSignalWithNextSeq({ runId: "r1", signalName: "go", correlationId: "c", payloadJson: "{}", receivedAtMs: 1, receivedBy: null });
        expect(seq1).toBe(1);
    });
});
