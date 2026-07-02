import { afterEach, describe, expect, test } from "bun:test";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import {
  serializeApprovalRow,
  serializeCronRow,
  serializeDocRow,
  serializeMemoryFactRow,
  serializeRunEventRow,
  serializeRunRow,
  serializeScoreRow,
  serializeTicketRow,
} from "@smithers-orchestrator/gateway/api";
import { createSmithersPostgres } from "smithers-orchestrator";
import { mapSmithersElectricRow } from "../../src/data/mapSmithersElectricRow.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function rawOne(connection: { query: (query: { text: string; values?: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> }, text: string, values: unknown[]) {
  const result = await connection.query({ text, values });
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

describe("Electric row-shape parity", () => {
  test("maps raw pglite table rows to the same shape as the REST API serializers", async () => {
    const api = await createSmithersPostgres({}, { provider: "pglite" });
    cleanups.push(() => api.close());
    const adapter = new SmithersDb(api.db);
    const connection = (api.db as { connection: { query: (query: { text: string; values?: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> } }).connection;
    const now = 1_718_000_000_000;
    const runId = "run-parity-real";

    await adapter.insertRun({
      runId,
      workflowName: "value",
      status: "finished",
      createdAtMs: now,
      startedAtMs: now + 1,
      finishedAtMs: now + 2,
      configJson: JSON.stringify({ gatewayWorkflowKey: "value" }),
    });
    await adapter.insertEventWithNextSeq({
      runId,
      timestampMs: now + 3,
      type: "node.output",
      payloadJson: JSON.stringify({ nodeId: "task1", value: 42 }),
    });
    await connection.query({
      text: `INSERT INTO _smithers_approvals
        (run_id, node_id, iteration, status, requested_at_ms, request_json, auto_approved)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      values: [runId, "approval", 0, "requested", now + 4, JSON.stringify({
        title: "Approve",
        summary: "Approve the action",
        mode: "manual",
        options: [{ id: "yes", label: "Yes" }],
        allowedScopes: ["run:write"],
        allowedUsers: ["user:operator"],
        autoApprove: false,
      }), 0],
    });
    await adapter.upsertDoc({
      path: "docs/readme.md",
      kind: "doc",
      content: "hello",
      contentHash: "hash-doc",
      status: "open",
      updatedAtMs: now + 5,
      deletedAtMs: null,
    });
    await adapter.upsertDoc({
      path: "tickets/t-1.md",
      kind: "ticket",
      content: "fix it",
      contentHash: "hash-ticket",
      status: "open",
      updatedAtMs: now + 6,
      deletedAtMs: null,
    });
    await connection.query({
      text: `INSERT INTO _smithers_scorers
        (id, run_id, node_id, iteration, attempt, scorer_id, scorer_name, source, score, reason, scored_at_ms, latency_ms, duration_ms)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      values: ["score-row-1", runId, "task1", 0, 0, "score:exact", "Exact", "eval", 1, null, now + 7, 12, 34],
    });
    await connection.query({
      text: `INSERT INTO _smithers_memory_facts (namespace, key, value_json, schema_sig, created_at_ms, updated_at_ms, ttl_ms)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      values: ["workspace", "preference", JSON.stringify({ theme: "plain" }), "sig-memory", now + 8, now + 9, null],
    });
    await adapter.upsertCron({
      cronId: "cron-parity",
      pattern: "*/5 * * * *",
      workflowPath: "gateway:value",
      enabled: true,
      createdAtMs: now + 10,
      lastRunAtMs: null,
      nextRunAtMs: now + 20,
      errorJson: null,
    });

    const apiRun = serializeRunRow(await adapter.getRun(runId) as Record<string, unknown>);
    const apiEvent = serializeRunEventRow((await adapter.listEvents(runId, -1, 10))[0] as Record<string, unknown>);
    const apiApproval = serializeApprovalRow((await adapter.listPendingApprovals(runId))[0] as Record<string, unknown>);
    const apiDoc = serializeDocRow((await adapter.listDocs({ kind: "doc" }))[0] as Record<string, unknown>);
    const apiTicket = serializeTicketRow((await adapter.listDocs({ kind: "ticket" }))[0] as Record<string, unknown>);
    const apiScore = serializeScoreRow((await adapter.listScorerResults(runId))[0] as Record<string, unknown>);
    const apiMemory = serializeMemoryFactRow((await adapter.listMemoryFacts("workspace"))[0] as Record<string, unknown>);
    const apiCron = serializeCronRow((await adapter.listCrons(false))[0] as Record<string, unknown>);

    expect(mapSmithersElectricRow("runs", await rawOne(connection, "SELECT * FROM _smithers_runs WHERE run_id = $1", [runId]))).toEqual(apiRun);
    expect(mapSmithersElectricRow("run", await rawOne(connection, "SELECT * FROM _smithers_runs WHERE run_id = $1", [runId]))).toEqual(apiRun);
    expect(mapSmithersElectricRow("events", await rawOne(connection, "SELECT * FROM _smithers_events WHERE run_id = $1", [runId]))).toEqual(apiEvent);
    expect(mapSmithersElectricRow("approvals", await rawOne(connection, "SELECT * FROM _smithers_approvals WHERE run_id = $1", [runId]))).toEqual(apiApproval);
    expect(mapSmithersElectricRow("docs", await rawOne(connection, "SELECT * FROM _smithers_docs WHERE path = $1", ["docs/readme.md"]))).toEqual(apiDoc);
    expect(mapSmithersElectricRow("tickets", await rawOne(connection, "SELECT * FROM _smithers_docs WHERE path = $1", ["tickets/t-1.md"]))).toEqual(apiTicket);
    expect(mapSmithersElectricRow("scores", await rawOne(connection, "SELECT * FROM _smithers_scorers WHERE run_id = $1", [runId]))).toEqual(apiScore);
    expect(mapSmithersElectricRow("memoryFacts", await rawOne(connection, "SELECT * FROM _smithers_memory_facts WHERE namespace = $1 AND key = $2", ["workspace", "preference"]))).toEqual(apiMemory);
    expect(mapSmithersElectricRow("crons", await rawOne(connection, "SELECT * FROM _smithers_cron WHERE cron_id = $1", ["cron-parity"]))).toEqual(apiCron);
  }, 120_000);

  test("maps output-table rows to the GatewayRunNode row shape used by REST runTree", () => {
    expect(mapSmithersElectricRow("nodes", {
      run_id: "run-parity",
      node_id: "task1",
      iteration: 0,
      state: "completed",
      label: "Task one",
      output_table: "result",
    })).toEqual({
      key: "run-parity:task1:0",
      id: "task1",
      name: "Task one",
      cardLabel: "Task one",
      kind: "result",
      status: "completed",
      iteration: 0,
      childIds: [],
    });
  });
});
