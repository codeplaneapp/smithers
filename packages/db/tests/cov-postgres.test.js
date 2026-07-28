/**
 * Postgres-dialect coverage for the SmithersDb adapter and the output/snapshot
 * helpers. Boots a real in-process PGlite instance exposed over the Postgres
 * wire protocol (the same real backend the existing db-postgres-dialect suite
 * uses) — no mocks. Set SMITHERS_TEST_PG_URL to run against a real PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import pg from "pg";
import { z } from "zod";
import { SmithersDb } from "../src/adapter.js";
import { SqlMessageStorage } from "../src/sql-message-storage.js";
import { zodToTable } from "../src/zodToTable.js";
import { syncZodTableSchemaPostgres } from "../src/zodToCreateTableSQL.js";
import { loadInput, loadInputEffect, loadOutputs, loadRunOutputRowsEffect } from "../src/snapshot.js";
import { selectOutputRow } from "../src/output.js";
import { Effect } from "effect";

pg.types.setTypeParser(20, (value) => (value === null ? null : Number(value)));
setDefaultTimeout(120_000);

const PG_URL = process.env.SMITHERS_TEST_PG_URL;
const HOST = "127.0.0.1";
const PORT = 5545;

let pglite;
let server;
let client;
let schema;
/** @type {SqlMessageStorage} */
let storage;
/** @type {SmithersDb} */
let adapter;
/** @type {{ dialect: "postgres"; connection: import("pg").Client }} */
let dbDescriptor;

const now = 1_700_000_000_000;

async function openIsolatedPgClient({ defaultInt8Strings = false } = {}) {
  const types = defaultInt8Strings
    ? {
        getTypeParser(oid, format) {
          if (oid === 20) return (value) => value;
          return pg.types.getTypeParser(oid, format);
        },
      }
    : undefined;
  const isolated = PG_URL
    ? new pg.Client({ connectionString: PG_URL, types })
    : new pg.Client({ host: HOST, port: PORT, database: "postgres", user: "postgres", ssl: false, types });
  await isolated.connect();
  if (PG_URL && schema) {
    await isolated.query(`SET search_path TO "${schema}"`);
  }
  return isolated;
}

describe.skipIf(process.platform === "win32" && !PG_URL)("SmithersDb + snapshot postgres dialect (PGlite)", () => {
  beforeAll(async () => {
    if (PG_URL) {
      client = new pg.Client({ connectionString: PG_URL });
      await client.connect();
      schema = `smithers_cov_${Date.now().toString(36)}`;
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
    } else {
      const { PGlite } = await import("@electric-sql/pglite");
      const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
      pglite = await PGlite.create();
      server = new PGLiteSocketServer({ db: pglite, host: HOST, port: PORT, maxConnections: 5 });
      await server.start();
      client = new pg.Client({ host: HOST, port: PORT, database: "postgres", user: "postgres", ssl: false });
      await client.connect();
    }
    dbDescriptor = { dialect: "postgres", connection: client };
    storage = new SqlMessageStorage(dbDescriptor);
    await storage.ensureSchema();
    adapter = new SmithersDb(dbDescriptor);
  });

  afterAll(async () => {
    if (PG_URL && schema && client) {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    }
    await client?.end().catch(() => {});
    await server?.stop().catch(() => {});
    await pglite?.close().catch(() => {});
  });

  test("run CRUD + ancestry + signals via the postgres query paths", async () => {
    await adapter.insertRun({ runId: "pg-root", workflowName: "wf", status: "running", createdAtMs: now });
    await adapter.insertRun({
      runId: "pg-child",
      workflowName: "wf",
      status: "running",
      createdAtMs: now,
      parentRunId: "pg-root",
    });
    expect((await adapter.getRun("pg-child")).parentRunId).toBe("pg-root");
    const ancestry = await adapter.listRunAncestry("pg-child");
    expect(ancestry.map((r) => r.runId)).toEqual(["pg-child", "pg-root"]);

    // insertSignalWithNextSeq takes the PostgreSQL atomic allocator path.
    const seq0 = await adapter.insertSignalWithNextSeq({
      runId: "pg-root",
      signalName: "go",
      correlationId: null,
      payloadJson: "{}",
      receivedAtMs: now,
      receivedBy: null,
    });
    expect(seq0).toBe(0);
    const seq1 = await adapter.insertSignalWithNextSeq({
      runId: "pg-root",
      signalName: "go",
      correlationId: "c",
      payloadJson: "{}",
      receivedAtMs: now,
      receivedBy: null,
    });
    expect(seq1).toBe(1);
    expect((await adapter.listSignals("pg-root")).length).toBe(2);
  });

  test("event allocation via the PostgreSQL atomic allocator", async () => {
    await adapter.insertEventWithNextSeq({
      runId: "pg-root",
      timestampMs: now,
      type: "run.started",
      payloadJson: "{}",
    });
    await adapter.insertEventWithNextSeq({
      runId: "pg-root",
      timestampMs: now + 1,
      type: "run.progress",
      payloadJson: "{}",
    });
    expect(await adapter.getLastEventSeq("pg-root")).toBe(1);
    expect((await adapter.listEvents("pg-root", -1, 10)).length).toBe(2);
  });

  test("content-addressed agent checkpoints dedupe, scope, cascade, and prune", async () => {
    await adapter.insertRun({ runId: "pg-root", workflowName: "wf", status: "running", createdAtMs: now });
    await adapter.insertAttempt({
      runId: "pg-root",
      nodeId: "checkpoint-agent",
      iteration: 0,
      attempt: 1,
      state: "in-progress",
      startedAtMs: now,
    });
    const base = {
      runId: "pg-root",
      nodeId: "checkpoint-agent",
      iteration: 0,
      attempt: 1,
      checkpointJson: '{"cursor":"pg"}',
      codec: "json",
      version: 1,
      agentId: "agent:pg",
      purpose: "resume",
      runtimeOwnerId: null,
    };
    const checkpointClient = await openIsolatedPgClient({ defaultInt8Strings: true });
    const checkpointAdapter = new SmithersDb({ dialect: "postgres", connection: checkpointClient });
    let first;
    try {
      first = await checkpointAdapter.putAgentCheckpoint({ ...base, sequence: 0, createdAtMs: now });
      const second = await checkpointAdapter.putAgentCheckpoint({ ...base, sequence: 1, createdAtMs: now + 1 });
      const rawRef = await checkpointClient.query(
        "SELECT iteration, attempt, sequence, version, created_at_ms FROM _smithers_agent_checkpoints WHERE run_id = $1 LIMIT 1",
        ["pg-root"],
      );
      expect(Object.values(rawRef.rows[0]).every((value) => typeof value === "string")).toBe(true);
      expect(second.contentHash).toBe(first.contentHash);
      expect(first).toMatchObject({ iteration: 0, attempt: 1, sequence: 0, version: 1, createdAtMs: now });
      expect(await checkpointAdapter.getAgentCheckpoint(first.contentHash)).toMatchObject({
        checkpointJson: base.checkpointJson,
        sizeBytes: Buffer.byteLength(base.checkpointJson, "utf8"),
        createdAtMs: now,
      });
      expect(await checkpointAdapter.listAgentCheckpointRefs("pg-root", { nodeId: "checkpoint-agent" })).toMatchObject([
        { iteration: 0, attempt: 1, sequence: 0, version: 1, createdAtMs: now },
        { iteration: 0, attempt: 1, sequence: 1, version: 1, createdAtMs: now + 1 },
      ]);
      expect(await checkpointAdapter.listLatestAgentCheckpointRefs("pg-root", "checkpoint-agent", 0)).toMatchObject([
        { iteration: 0, attempt: 1, sequence: 1, version: 1, createdAtMs: now + 1 },
      ]);
      expect(await checkpointAdapter.getNextAgentCheckpointSequence("pg-root", "checkpoint-agent", 0, 1)).toBe(2);
    } finally {
      await checkpointClient.end();
    }
    await adapter.updateAttempt("pg-root", "checkpoint-agent", 0, 1, {
      state: "cancelled",
      metaJson: JSON.stringify({ resetCancelled: true }),
    });
    expect(await adapter.deleteResetAgentCheckpoints("pg-root", "checkpoint-agent", 0, 1, "stale-owner")).toBe(false);
    expect(await adapter.listAgentCheckpointRefs("pg-root", { nodeId: "checkpoint-agent" })).toHaveLength(2);
    expect(await adapter.deleteResetAgentCheckpoints("pg-root", "checkpoint-agent", 0, 1, null)).toBe(true);
    expect(await adapter.listAgentCheckpointRefs("pg-root", { nodeId: "checkpoint-agent" })).toEqual([]);
    expect(await adapter.getAgentCheckpoint(first.contentHash)).toBeNull();
  });

  test("checkpoint GC coordinates with an independent checkpoint writer", async () => {
    await adapter.insertAttempt({
      runId: "pg-root",
      nodeId: "checkpoint-gc-race",
      iteration: 0,
      attempt: 1,
      state: "in-progress",
      startedAtMs: now,
    });
    const writerClient = await openIsolatedPgClient();
    const gcClient = await openIsolatedPgClient();
    try {
      const writer = new SmithersDb({ dialect: "postgres", connection: writerClient });
      const collector = new SmithersDb({ dialect: "postgres", connection: gcClient });
      const [stored] = await Promise.all([
        writer.putAgentCheckpoint({
          runId: "pg-root",
          nodeId: "checkpoint-gc-race",
          iteration: 0,
          attempt: 1,
          sequence: 0,
          checkpointJson: '{"cursor":"gc-race"}',
          codec: "json",
          version: 1,
          purpose: "resume",
          createdAtMs: now,
          runtimeOwnerId: null,
        }),
        collector.pruneOrphanedAgentCheckpointContents(),
      ]);
      expect(stored).not.toBeNull();
      expect(await adapter.getAgentCheckpoint(stored.contentHash)).not.toBeNull();
      expect(await adapter.listAgentCheckpointRefs("pg-root", { nodeId: "checkpoint-gc-race" })).toHaveLength(1);
    } finally {
      await writerClient.end();
      await gcClient.end();
    }
  });

  test("output tables: syncZodTableSchemaPostgres + upsert + raw read + delete + hasPhysicalTable", async () => {
    const outSchema = z.object({ summary: z.string(), ok: z.boolean() });
    const table = zodToTable("pg_out", outSchema);
    // Idempotent create + an ALTER-add pass (second call adds nothing new).
    await syncZodTableSchemaPostgres(client, "pg_out", outSchema);
    await syncZodTableSchemaPostgres(client, "pg_out", outSchema);

    await adapter.upsertOutputRow(table, { runId: "pg-root", nodeId: "n1", iteration: 0 }, { summary: "hi", ok: true });
    const raw = await adapter.getRawNodeOutput("pg_out", "pg-root", "n1");
    expect(raw.summary).toBe("hi");
    expect(Boolean(raw.ok)).toBe(true);
    const rawIter = await adapter.getRawNodeOutputForIteration("pg_out", "pg-root", "n1", 0);
    expect(rawIter.summary).toBe("hi");

    expect(await adapter.hasPhysicalTable("pg_out")).toBe(true);
    expect(await adapter.hasPhysicalTable("pg_missing")).toBe(false);

    // snapshot loadOutputs + selectOutputRow over the postgres descriptor.
    const outputs = await loadOutputs(dbDescriptor, { pgOut: table }, "pg-root");
    expect(outputs.pgOut.length).toBe(1);
    expect(outputs.pgOut[0].ok).toBe(true);
    const selected = await selectOutputRow(dbDescriptor, table, { runId: "pg-root", nodeId: "n1", iteration: 0 });
    expect(selected.summary).toBe("hi");

    // loadRunOutputRowsEffect over postgres: scoped by runId and unscoped.
    const scoped = await Effect.runPromise(loadRunOutputRowsEffect(dbDescriptor, table, "pg-root"));
    expect(scoped.length).toBe(1);
    const allRows = await Effect.runPromise(loadRunOutputRowsEffect(dbDescriptor, table));
    expect(allRows.length).toBeGreaterThanOrEqual(1);

    await adapter.deleteOutputRow("pg_out", { runId: "pg-root", nodeId: "n1", iteration: 0 });
    expect(await adapter.getRawNodeOutput("pg_out", "pg-root", "n1")).toBeNull();
  });

  test("loadInput surfaces a postgres query error through the catch branch", async () => {
    const inputTable = zodToTable("pg_phantom_input", z.object({ topic: z.string() }), { isInput: true });
    let isolatedClient;
    try {
      isolatedClient = await openIsolatedPgClient();
      const errorDescriptor = { dialect: "postgres", connection: isolatedClient };
      // Table never created → the postgres SELECT fails and maps to a SmithersError.
      const exit = await Effect.runPromiseExit(loadInputEffect(errorDescriptor, inputTable, "pg-root"));
      expect(exit._tag).toBe("Failure");
    } finally {
      await isolatedClient?.end().catch(() => {});
    }
  });

  test("input table: syncZodTableSchemaPostgres(isInput) + loadInput over postgres", async () => {
    const inSchema = z.object({ topic: z.string() });
    const inputTable = zodToTable("pg_input", inSchema, { isInput: true });
    await syncZodTableSchemaPostgres(client, "pg_input", inSchema, { isInput: true });
    await client.query(`INSERT INTO "pg_input" (run_id, topic) VALUES ($1, $2)`, ["pg-root", "ai"]);
    const loaded = await loadInput(dbDescriptor, inputTable, "pg-root");
    expect(loaded.topic).toBe("ai");
    expect(await loadInput(dbDescriptor, inputTable, "missing")).toBeUndefined();
  });

  test("claim / updateClaimedRun over postgres", async () => {
    await adapter.insertRun({
      runId: "pg-stale",
      workflowName: "wf",
      status: "running",
      createdAtMs: now,
      heartbeatAtMs: now - 100_000,
    });
    const claimed = await adapter.claimRunForResume({
      runId: "pg-stale",
      claimOwnerId: "sup",
      claimHeartbeatAtMs: now,
      expectedRuntimeOwnerId: null,
      expectedHeartbeatAtMs: now - 100_000,
      staleBeforeMs: now - 1000,
    });
    expect(claimed).toBe(true);
    const updated = await adapter.updateClaimedRun({
      runId: "pg-stale",
      expectedRuntimeOwnerId: "sup",
      expectedHeartbeatAtMs: now,
      patch: { status: "running" },
    });
    expect(updated).toBe(true);
  });

  test("toPostgresParam binds Buffer / Date / object params (vector-style blob write)", async () => {
    // Vectors store a blob embedding + JSON metadata → exercises the
    // Buffer and object param branches of toPostgresParam.
    const embedding = Buffer.from(new Uint8Array([1, 2, 3, 4]));
    await storage.execute(
      `INSERT INTO _smithers_vectors (id, namespace, content, embedding, dimensions, metadata_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["v1", "ns", "hello", embedding, 4, JSON.stringify({ a: 1 }), now],
    );
    const row = await storage.queryOne(`SELECT id, dimensions FROM _smithers_vectors WHERE id = ?`, ["v1"]);
    expect(row.id).toBe("v1");
    expect(row.dimensions).toBe(4);
  });
});
