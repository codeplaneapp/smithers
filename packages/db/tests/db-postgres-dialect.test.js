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
import { Effect } from "effect";
import pg from "pg";
import { z } from "zod";
import { SmithersDb } from "../src/adapter.js";
import { SqlMessageStorage } from "../src/sql-message-storage.js";
import { zodToTable } from "../src/zodToTable.js";
import { syncZodTableSchemaPostgres } from "../src/zodToCreateTableSQL.js";
import { POSTGRES } from "../src/dialect.js";

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

async function connectPeerClient() {
    const peer = PG_URL
        ? new pg.Client({ connectionString: PG_URL })
        : new pg.Client({ host: HOST, port: PORT, database: "postgres", user: "postgres", ssl: false });
    await peer.connect();
    if (schema) {
        await peer.query(`SET search_path TO "${schema}"`);
    }
    return peer;
}

function twoPartyBarrier() {
    let arrived = 0;
    let release;
    const ready = new Promise((resolve) => {
        release = resolve;
    });
    return async () => {
        arrived += 1;
        if (arrived === 2) release();
        await ready;
    };
}

function blockFirstInsert(connection, table, waitForPeer) {
    let blocked = false;
    return {
        async query(config) {
            const text = typeof config === "string" ? config : config.text;
            if (!blocked && text.includes(`INSERT INTO "${table}"`)) {
                blocked = true;
                await waitForPeer();
            }
            return connection.query(config);
        },
    };
}

function postgresAdapter(connection) {
    return new SmithersDb({ dialect: "postgres", connection });
}

// PGlite's socket server currently desyncs node-postgres on Windows CI. The
// real Postgres dialect still runs through the separate test-postgres job.
describe.skipIf(process.platform === "win32" && !PG_URL)("SqlMessageStorage postgres dialect", () => {
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

    test("reports the postgres dialect", () => {
        expect(storage.dialect).toBe("postgres");
    });

    test("reapplies scorer context columns when a legacy Postgres schema lacks them", async () => {
        await client.query("ALTER TABLE _smithers_scorers DROP COLUMN ground_truth_json, DROP COLUMN context_json");
        await client.query("DELETE FROM _smithers_schema_migrations WHERE id = '0017_add_scorer_context_columns'");

        await storage.ensureSchema();

        const result = await client.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = '_smithers_scorers'
              AND column_name IN ('ground_truth_json', 'context_json')
            ORDER BY column_name
        `);
        expect(result.rows.map((row) => row.column_name)).toEqual([
            "context_json",
            "ground_truth_json",
        ]);
    });

    test("ensureSchema created the internal tables", async () => {
        const rows = await storage.queryAll(
            "SELECT table_name FROM information_schema.tables WHERE table_name LIKE '_smithers_%' AND table_schema = current_schema()",
        );
        const names = new Set(rows.map((r) => r.tableName));
        expect(names.has("_smithers_runs")).toBe(true);
        expect(names.has("_smithers_events")).toBe(true);
        expect(names.has("_smithers_time_travel_audit")).toBe(true);
        expect(names.has("_smithers_rewind_leases")).toBe(true);
    });

    test("ensureSchema records the shared schema migration ledger idempotently", async () => {
        const before = await storage.queryAll("SELECT id FROM _smithers_schema_migrations ORDER BY id");
        const ids = before.map((row) => row.id);
        expect(ids).toContain("0001_current_tables");
        expect(ids).toContain("0014_current_indexes");
        expect(ids).toContain("0016_add_workspace_checkpoints");
        expect(ids).toContain("0018_add_docs");

        await storage.ensureSchema();
        const after = await storage.queryAll("SELECT id FROM _smithers_schema_migrations ORDER BY id");
        expect(after.map((row) => row.id)).toEqual(ids);
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

    test("pending approval fallback works through SmithersDb on postgres storage", async () => {
        const adapter = new SmithersDb(new Database(":memory:"));
        adapter.internalStorage = storage;
        await adapter.insertRun({
            runId: "run-pg-approval-fallback",
            workflowName: "pg-workflow",
            status: "waiting-approval",
            createdAtMs: 1717000000100,
        });
        await adapter.insertNode({
            runId: "run-pg-approval-fallback",
            nodeId: "pg-gate",
            iteration: 0,
            state: "waiting-approval",
            lastAttempt: null,
            updatedAtMs: 1717000000200,
            outputTable: "",
            label: "PG gate",
        });

        const runApprovals = await adapter.listPendingApprovals("run-pg-approval-fallback");
        expect(runApprovals).toHaveLength(1);
        expect(runApprovals[0]).toMatchObject({
            runId: "run-pg-approval-fallback",
            nodeId: "pg-gate",
            status: "requested",
            requestedAtMs: 1717000000200,
            autoApproved: false,
        });

        const allApprovals = await adapter.listAllPendingApprovals();
        const found = allApprovals.find((approval) => approval.runId === "run-pg-approval-fallback");
        expect(found).toMatchObject({
            nodeId: "pg-gate",
            workflowName: "pg-workflow",
            runStatus: "waiting-approval",
            nodeLabel: "PG gate",
        });
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

    test("deleteOutputRow resolves a camelCase key to a snake_case postgres output table", async () => {
        await storage.execute(`DROP TABLE IF EXISTS "pg_camel_output"`);
        await storage.execute(`
            CREATE TABLE "pg_camel_output" (
                run_id TEXT NOT NULL,
                node_id TEXT NOT NULL,
                iteration BIGINT NOT NULL,
                PRIMARY KEY (run_id, node_id, iteration)
            )
        `);
        await storage.execute(`INSERT INTO "pg_camel_output" (run_id, node_id, iteration) VALUES ('run-pg', 'node', 0)`);

        const adapter = new SmithersDb(new Database(":memory:"));
        adapter.internalStorage = storage;
        adapter.db = { _: { fullSchema: {} } };

        await adapter.deleteOutputRow("pgCamelOutput", { runId: "run-pg", nodeId: "node", iteration: 0 });
        const rows = await storage.queryAll(`SELECT * FROM "pg_camel_output"`);
        expect(rows).toHaveLength(0);
    });

    test("listNodeEvents escapes LIKE wildcards for postgres transcripts", async () => {
        const adapter = new SmithersDb(new Database(":memory:"));
        adapter.internalStorage = storage;
        adapter.db = { _: { fullSchema: {} } };
        await adapter.insertRun({ runId: "pg-events", workflowName: "wf", status: "running", createdAtMs: 1 });
        await adapter.insertEventWithNextSeq({ runId: "pg-events", timestampMs: 1, type: "node.started", payloadJson: '{"nodeId":"build_step"}' });
        await adapter.insertEventWithNextSeq({ runId: "pg-events", timestampMs: 2, type: "node.started", payloadJson: '{"nodeId":"buildXstep"}' });

        const events = await adapter.listNodeEvents("pg-events", "build_step");
        expect(events).toHaveLength(1);
        expect(events[0].payloadJson).toContain('"build_step"');
    });

    test("independent postgres adapters allocate and persist every event seq", async () => {
        const runId = "pg-cross-adapter-event-race";
        await storage.upsert(
            "_smithers_runs",
            { runId, workflowName: "demo", status: "running", createdAtMs: 1 },
            ["runId"],
        );

        const peer = await connectPeerClient();
        try {
            const waitForPeer = twoPartyBarrier();
            const first = postgresAdapter(blockFirstInsert(client, "_smithers_events", waitForPeer));
            const second = postgresAdapter(blockFirstInsert(peer, "_smithers_events", waitForPeer));
            const firstRow = {
                runId,
                timestampMs: 3000,
                type: "pg.race",
                payloadJson: JSON.stringify({ writer: "first" }),
            };
            const secondRow = {
                runId,
                timestampMs: 3001,
                type: "pg.race",
                payloadJson: JSON.stringify({ writer: "second" }),
            };

            const seqs = await Promise.all([
                first.insertEventWithNextSeq(firstRow),
                second.insertEventWithNextSeq(secondRow),
            ]);
            const sorted = [...seqs].sort((a, b) => a - b);
            expect(sorted).toEqual([0, 1]);
            expect(new Set(seqs).size).toBe(2);

            const history = await storage.listEventHistory(runId, { limit: 10 });
            expect(history.map((event) => event.seq)).toEqual([0, 1]);
            expect(history).toHaveLength(2);

            const redelivered = await Promise.all([
                first.insertEventWithNextSeq(firstRow),
                second.insertEventWithNextSeq(firstRow),
            ]);
            expect(redelivered).toEqual([seqs[0], seqs[0]]);
            expect(await storage.countEventHistory(runId)).toBe(2);

            const duplicateRunId = `${runId}-duplicate`;
            await storage.upsert(
                "_smithers_runs",
                { runId: duplicateRunId, workflowName: "demo", status: "running", createdAtMs: 1 },
                ["runId"],
            );
            const duplicateBarrier = twoPartyBarrier();
            const duplicateFirst = postgresAdapter(blockFirstInsert(client, "_smithers_events", duplicateBarrier));
            const duplicateSecond = postgresAdapter(blockFirstInsert(peer, "_smithers_events", duplicateBarrier));
            const duplicateRow = {
                runId: duplicateRunId,
                timestampMs: 3100,
                type: "pg.duplicate",
                payloadJson: JSON.stringify({ delivery: "same" }),
            };
            expect(await Promise.all([
                duplicateFirst.insertEventWithNextSeq(duplicateRow),
                duplicateSecond.insertEventWithNextSeq(duplicateRow),
            ])).toEqual([0, 0]);
            expect(await storage.countEventHistory(duplicateRunId)).toBe(1);
        }
        finally {
            await peer.end().catch(() => {});
        }
    }, 60_000);

    test("event seq allocation remains idempotent inside an outer postgres transaction", async () => {
        const runId = "pg-outer-transaction-event";
        await storage.upsert(
            "_smithers_runs",
            { runId, workflowName: "demo", status: "running", createdAtMs: 1 },
            ["runId"],
        );
        const adapter = postgresAdapter(client);
        const row = {
            runId,
            timestampMs: 3500,
            type: "pg.outer",
            payloadJson: JSON.stringify({ writer: "transaction" }),
        };

        const first = await adapter.withTransaction(
            "outer event",
            Effect.suspend(() => adapter.insertEventWithNextSeq(row)),
        );
        const second = await adapter.withTransaction(
            "outer event redelivery",
            Effect.suspend(() => adapter.insertEventWithNextSeq(row)),
        );

        expect(first).toBe(0);
        expect(second).toBe(first);
        expect(await storage.countEventHistory(runId)).toBe(1);
    }, 60_000);

    // PGlite's socket server serializes the peer's first query behind an open
    // transaction. Real PostgreSQL permits both connections to overlap here.
    test.skipIf(!PG_URL)("outer postgres transaction coordinates event seq allocation with an independent writer", async () => {
        const runId = "pg-real-outer-event-race";
        await storage.upsert(
            "_smithers_runs",
            { runId, workflowName: "demo", status: "running", createdAtMs: 1 },
            ["runId"],
        );

        const peer = await connectPeerClient();
        try {
            const waitForPeer = twoPartyBarrier();
            const first = postgresAdapter(blockFirstInsert(client, "_smithers_events", waitForPeer));
            const second = postgresAdapter(blockFirstInsert(peer, "_smithers_events", waitForPeer));
            const seqs = await Promise.all([
                first.withTransaction("outer event race", Effect.suspend(() => first.insertEventWithNextSeq({
                    runId,
                    timestampMs: 3600,
                    type: "pg.outer.race",
                    payloadJson: JSON.stringify({ writer: "transaction" }),
                }))),
                second.insertEventWithNextSeq({
                    runId,
                    timestampMs: 3601,
                    type: "pg.outer.race",
                    payloadJson: JSON.stringify({ writer: "standalone" }),
                }),
            ]);

            expect([...seqs].sort((a, b) => a - b)).toEqual([0, 1]);
            expect(new Set(seqs).size).toBe(2);
            expect(await storage.countEventHistory(runId)).toBe(2);
        }
        finally {
            await peer.end().catch(() => {});
        }
    }, 60_000);

    test("independent postgres adapters allocate and persist every signal seq", async () => {
        const runId = "pg-cross-adapter-signal-race";
        await storage.upsert(
            "_smithers_runs",
            { runId, workflowName: "demo", status: "running", createdAtMs: 1 },
            ["runId"],
        );

        const peer = await connectPeerClient();
        try {
            const waitForPeer = twoPartyBarrier();
            const first = postgresAdapter(blockFirstInsert(client, "_smithers_signals", waitForPeer));
            const second = postgresAdapter(blockFirstInsert(peer, "_smithers_signals", waitForPeer));
            const firstRow = {
                runId,
                signalName: "go",
                correlationId: "first",
                payloadJson: JSON.stringify({ writer: "first" }),
                receivedAtMs: 4000,
                receivedBy: null,
            };
            const secondRow = {
                runId,
                signalName: "go",
                correlationId: "second",
                payloadJson: JSON.stringify({ writer: "second" }),
                receivedAtMs: 4001,
                receivedBy: "gateway",
            };

            const seqs = await Promise.all([
                first.insertSignalWithNextSeq(firstRow),
                second.insertSignalWithNextSeq(secondRow),
            ]);
            const sorted = [...seqs].sort((a, b) => a - b);
            expect(sorted).toEqual([0, 1]);
            expect(new Set(seqs).size).toBe(2);

            const signals = await storage.queryAll(
                "SELECT * FROM _smithers_signals WHERE run_id = ? ORDER BY seq ASC",
                [runId],
            );
            expect(signals.map((signal) => signal.seq)).toEqual([0, 1]);
            expect(signals).toHaveLength(2);

            const redelivered = await Promise.all([
                first.insertSignalWithNextSeq(firstRow),
                second.insertSignalWithNextSeq(firstRow),
            ]);
            expect(redelivered).toEqual([seqs[0], seqs[0]]);
            expect(await storage.getLastSignalSeq(runId)).toBe(1);
            expect(await storage.queryAll(
                "SELECT seq FROM _smithers_signals WHERE run_id = ? ORDER BY seq ASC",
                [runId],
            )).toHaveLength(2);

            const duplicateRunId = `${runId}-duplicate`;
            await storage.upsert(
                "_smithers_runs",
                { runId: duplicateRunId, workflowName: "demo", status: "running", createdAtMs: 1 },
                ["runId"],
            );
            const duplicateBarrier = twoPartyBarrier();
            const duplicateFirst = postgresAdapter(blockFirstInsert(client, "_smithers_signals", duplicateBarrier));
            const duplicateSecond = postgresAdapter(blockFirstInsert(peer, "_smithers_signals", duplicateBarrier));
            const duplicateRow = {
                runId: duplicateRunId,
                signalName: "go",
                correlationId: null,
                payloadJson: JSON.stringify({ delivery: "same" }),
                receivedAtMs: 4100,
                receivedBy: null,
            };
            expect(await Promise.all([
                duplicateFirst.insertSignalWithNextSeq(duplicateRow),
                duplicateSecond.insertSignalWithNextSeq(duplicateRow),
            ])).toEqual([0, 0]);
            expect(await storage.queryAll(
                "SELECT seq FROM _smithers_signals WHERE run_id = ?",
                [duplicateRunId],
            )).toHaveLength(1);
        }
        finally {
            await peer.end().catch(() => {});
        }
    }, 60_000);

    async function columnNames(table) {
        const result = await client.query({
            text: `SELECT column_name FROM information_schema.columns
                     WHERE table_name = $1 AND table_schema = current_schema()`,
            values: [table],
        });
        return new Set(result.rows.map((row) => row.column_name));
    }

    test("syncZodTableSchemaPostgres adds newly introduced columns to a stale output table", async () => {
        const table = `out_evolve_${Date.now().toString(36)}`;
        // v1 schema: a single user column. Create + seed a row.
        await syncZodTableSchemaPostgres(client, table, z.object({ a: z.string() }), {
            dialect: POSTGRES,
        });
        await client.query({
            text: `INSERT INTO "${table}" (run_id, node_id, iteration, a) VALUES ($1, $2, $3, $4)`,
            values: ["r1", "n1", 0, "hello"],
        });

        // v2 schema adds `b`; the ALTER-add path must introduce it without
        // dropping the existing row.
        await syncZodTableSchemaPostgres(
            client,
            table,
            z.object({ a: z.string(), b: z.number() }),
            { dialect: POSTGRES },
        );

        expect(await columnNames(table)).toContain("b");
        const rows = await client.query({
            text: `SELECT a, b FROM "${table}" WHERE run_id = $1`,
            values: ["r1"],
        });
        expect(rows.rows[0].a).toBe("hello");
        expect(rows.rows[0].b).toBeNull();

        // Idempotent: a repeat call with the same schema is a no-op (ADD COLUMN
        // IF NOT EXISTS), and the row is still intact.
        await syncZodTableSchemaPostgres(
            client,
            table,
            z.object({ a: z.string(), b: z.number() }),
            { dialect: POSTGRES },
        );
        const after = await client.query({
            text: `SELECT count(*)::int AS n FROM "${table}"`,
        });
        expect(after.rows[0].n).toBe(1);
    }, 60_000);

    test("syncZodTableSchemaPostgres evolves an isInput table", async () => {
        const table = `in_evolve_${Date.now().toString(36)}`;
        await syncZodTableSchemaPostgres(client, table, z.object({ x: z.string() }), {
            dialect: POSTGRES,
            isInput: true,
        });
        await client.query({
            text: `INSERT INTO "${table}" (run_id, x) VALUES ($1, $2)`,
            values: ["r1", "value"],
        });

        await syncZodTableSchemaPostgres(
            client,
            table,
            z.object({ x: z.string(), y: z.string() }),
            { dialect: POSTGRES, isInput: true },
        );

        expect(await columnNames(table)).toContain("y");
        const rows = await client.query({
            text: `SELECT x, y FROM "${table}" WHERE run_id = $1`,
            values: ["r1"],
        });
        expect(rows.rows[0].x).toBe("value");
        expect(rows.rows[0].y).toBeNull();
    }, 60_000);

    test("a failing statement surfaces a Postgres diagnostic message", async () => {
        let caught;
        try {
            await storage.queryAll("SELECT * FROM __missing_pg_table__");
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeDefined();
        const message = caught instanceof Error ? caught.message : String(caught);
        expect(message).toMatch(/Failed to execute Postgres statement: .+; sql=.+/);
        expect(message).toContain("sql=SELECT * FROM __missing_pg_table__");
    });
});
