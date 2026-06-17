/**
 * End-to-end coverage of the PostgreSQL dialect for SqlMessageStorage. This is
 * the same path real PostgreSQL/PGlite backends use: the storage layer talks to
 * a node-postgres connection, and every `?` placeholder, DDL type, upsert, and
 * json_extract is translated for PostgreSQL.
 *
 * By default the test is self-contained — it boots an in-process PGlite instance
 * exposed over the Postgres wire protocol by a socket server. Set
 * `SMITHERS_TEST_PG_URL` to run against a real PostgreSQL instead (faster; uses a
 * throwaway schema that is dropped afterwards).
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import pg from "pg";
import { z } from "zod";
import { SmithersDb } from "../src/adapter.js";
import { SqlMessageStorage } from "../src/sql-message-storage.js";
import { zodToTable } from "../src/zodToTable.js";

// node-postgres returns int8 (BIGINT) as a string by default to avoid precision
// loss; Smithers stores millisecond timestamps and booleans in BIGINT columns
// and expects JS numbers, so parse int8 as Number (safe below 2^53).
pg.types.setTypeParser(20, (value) => (value === null ? null : Number(value)));

// PGlite compiles a WASM build on first boot, which can be slow on a loaded box.
setDefaultTimeout(120_000);

const PG_URL = process.env.SMITHERS_TEST_PG_URL;
const HOST = "127.0.0.1";
const PORT = 5544;

let pglite;
let server;
let client;
let schema;
/** @type {SqlMessageStorage} */
let storage;

beforeAll(async () => {
    if (PG_URL) {
        client = new pg.Client({ connectionString: PG_URL });
        await client.connect();
        schema = `smithers_test_${Date.now().toString(36)}`;
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
        await client.query(`SET search_path TO "${schema}"`);
    }
    else {
        const { PGlite } = await import("@electric-sql/pglite");
        const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
        pglite = await PGlite.create();
        server = new PGLiteSocketServer({ db: pglite, host: HOST, port: PORT, maxConnections: 5 });
        await server.start();
        client = new pg.Client({ host: HOST, port: PORT, database: "postgres", user: "postgres", ssl: false });
        await client.connect();
    }
    storage = new SqlMessageStorage({ dialect: "postgres", connection: client });
    await storage.ensureSchema();
});

afterAll(async () => {
    if (PG_URL && schema && client) {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    }
    await client?.end().catch(() => {});
    await server?.stop().catch(() => {});
    await pglite?.close().catch(() => {});
});

describe("SqlMessageStorage postgres dialect", () => {
    test("reports the postgres dialect", () => {
        expect(storage.dialect).toBe("postgres");
    });

    test("ensureSchema created the internal tables", async () => {
        const rows = await storage.queryAll(
            "SELECT table_name FROM information_schema.tables WHERE table_name LIKE '_smithers_%' AND table_schema = current_schema()",
        );
        const names = new Set(rows.map((r) => r.tableName));
        expect(names.has("_smithers_runs")).toBe(true);
        expect(names.has("_smithers_events")).toBe(true);
        expect(names.has("_smithers_time_travel_audit")).toBe(true);
    });

    test("upsert inserts then updates on conflict (BIGINT ms timestamp round-trips as number)", async () => {
        await storage.upsert(
            "_smithers_runs",
            { runId: "run-1", workflowName: "demo", status: "running", createdAtMs: 1717000000000 },
            ["runId"],
        );
        let row = await storage.queryOne("SELECT * FROM _smithers_runs WHERE run_id = ?", ["run-1"]);
        expect(row.status).toBe("running");
        expect(row.createdAtMs).toBe(1717000000000);
        expect(typeof row.createdAtMs).toBe("number");

        await storage.upsert(
            "_smithers_runs",
            { runId: "run-1", workflowName: "demo", status: "finished", createdAtMs: 1717000000000 },
            ["runId"],
        );
        row = await storage.queryOne("SELECT * FROM _smithers_runs WHERE run_id = ?", ["run-1"]);
        expect(row.status).toBe("finished");
    });

    test("insertIgnore is a no-op on primary-key conflict", async () => {
        await storage.insertIgnore("_smithers_runs", {
            runId: "run-1",
            workflowName: "should-not-overwrite",
            status: "running",
            createdAtMs: 1,
        });
        const row = await storage.queryOne("SELECT * FROM _smithers_runs WHERE run_id = ?", ["run-1"]);
        // Still the finished row from the prior upsert — ignore did not clobber it.
        expect(row.status).toBe("finished");
        expect(row.workflowName).toBe("demo");
    });

    test("updateWhere patches matching rows", async () => {
        await storage.updateWhere("_smithers_runs", { status: "archived" }, "run_id = ?", ["run-1"]);
        const row = await storage.queryOne("SELECT status FROM _smithers_runs WHERE run_id = ?", ["run-1"]);
        expect(row.status).toBe("archived");
    });

    test("boolean columns encode to 0/1 and decode back to booleans", async () => {
        await storage.upsert(
            "_smithers_ralph",
            { runId: "run-1", ralphId: "ralph-1", iteration: 0, done: true, updatedAtMs: 5 },
            ["runId", "ralphId"],
        );
        const row = await storage.queryOne(
            "SELECT * FROM _smithers_ralph WHERE run_id = ? AND ralph_id = ?",
            ["run-1", "ralph-1"],
            { booleanColumns: ["done"] },
        );
        expect(row.done).toBe(true);
    });

    test("bytea columns round-trip as Buffers", async () => {
        const embedding = Buffer.from([0x01, 0x02, 0x03, 0x04]);
        await storage.upsert(
            "_smithers_vectors",
            {
                id: "vec-1",
                namespace: "ns",
                content: "hello",
                embedding,
                dimensions: 4,
                createdAtMs: 10,
            },
            ["id"],
        );
        const row = await storage.queryOne("SELECT * FROM _smithers_vectors WHERE id = ?", ["vec-1"]);
        expect(Buffer.isBuffer(row.embedding)).toBe(true);
        expect(Array.from(row.embedding)).toEqual([0x01, 0x02, 0x03, 0x04]);
    });

    test("event history filters by nodeId via json_extract → postgres ->>", async () => {
        await storage.execute(
            "INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json) VALUES (?, ?, ?, ?, ?)",
            ["run-1", 1, 100, "node.started", JSON.stringify({ nodeId: "alpha" })],
        );
        await storage.execute(
            "INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json) VALUES (?, ?, ?, ?, ?)",
            ["run-1", 2, 200, "node.started", JSON.stringify({ nodeId: "beta" })],
        );
        const alpha = await storage.listEventHistory("run-1", { nodeId: "alpha" });
        expect(alpha.length).toBe(1);
        expect(alpha[0].seq).toBe(1);

        const lastSeq = await storage.getLastEventSeq("run-1");
        expect(lastSeq).toBe(2);

        const count = await storage.countEventHistory("run-1");
        expect(count).toBe(2);
    });

    test("listEventHistory honors the IN (...) type filter", async () => {
        const rows = await storage.listEventHistory("run-1", { types: ["node.started"] });
        expect(rows.length).toBe(2);
    });

    test("SmithersDb exercises postgres output row adapter branches", async () => {
        await storage.execute(`DROP TABLE IF EXISTS "pg_adapter_output"`);
        await storage.execute(`
            CREATE TABLE "pg_adapter_output" (
                run_id TEXT NOT NULL,
                node_id TEXT NOT NULL,
                iteration BIGINT NOT NULL,
                title TEXT NOT NULL,
                approved BIGINT NOT NULL,
                PRIMARY KEY (run_id, node_id, iteration)
            )
        `);
        const table = zodToTable("pg_adapter_output", z.object({
            title: z.string(),
            approved: z.boolean(),
        }));
        const adapter = new SmithersDb(new Database(":memory:"));
        adapter.internalStorage = storage;
        adapter.db = { _: { fullSchema: { pgAdapterOutput: table } } };

        await adapter.upsertOutputRow(table, { runId: "run-pg", nodeId: "node", iteration: 0 }, {
            title: "first",
            approved: false,
        });
        await adapter.upsertOutputRow(table, { runId: "run-pg", nodeId: "node", iteration: 0 }, {
            title: "second",
            approved: true,
        });

        const row = await adapter.getRawNodeOutputForIteration("pg_adapter_output", "run-pg", "node", 0);
        expect(row).toMatchObject({
            run_id: "run-pg",
            node_id: "node",
            iteration: 0,
            title: "second",
            approved: true,
        });

        await adapter.deleteOutputRow("pg_adapter_output", { runId: "run-pg", nodeId: "node", iteration: 0 });
        expect(await adapter.getRawNodeOutputForIteration("pg_adapter_output", "run-pg", "node", 0)).toBeNull();
    });
});
