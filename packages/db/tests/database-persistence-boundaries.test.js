import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { z } from "zod";

import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";
import { buildOutputRow, selectOutputRow, upsertOutputRow, validateOutput } from "../src/output.js";
import { zodToCreateTableSQL } from "../src/zodToCreateTableSQL.js";
import { zodToTable } from "../src/zodToTable.js";

function createAdapter() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, db, adapter: new SmithersDb(db) };
}

function alertRow(overrides = {}) {
  return {
    alertId: "alert-1",
    runId: "run-1",
    policyName: "run_failed",
    severity: "critical",
    status: "firing",
    firedAtMs: 1_000,
    resolvedAtMs: null,
    acknowledgedAtMs: null,
    message: "Run failed",
    detailsJson: null,
    fingerprint: null,
    nodeId: null,
    iteration: null,
    owner: null,
    runbook: null,
    labelsJson: null,
    reactionJson: null,
    sourceEventType: null,
    firstFiredAtMs: null,
    lastFiredAtMs: null,
    occurrenceCount: 1,
    silencedUntilMs: null,
    acknowledgedBy: null,
    resolvedBy: null,
    ...overrides,
  };
}

function humanRequestRow(overrides = {}) {
  return {
    requestId: "human-1",
    runId: "run-1",
    nodeId: "gate",
    iteration: 0,
    kind: "approval",
    status: "pending",
    prompt: "Approve?",
    schemaJson: null,
    optionsJson: null,
    responseJson: null,
    requestedAtMs: 100,
    answeredAtMs: null,
    answeredBy: null,
    timeoutAtMs: null,
    ...overrides,
  };
}

describe("database persistence boundary coverage", () => {
  test("ensureSmithersTables creates the full current internal table set", () => {
    const sqlite = new Database(":memory:");
    try {
      ensureSmithersTables(drizzle(sqlite));
      const names = sqlite
        .query("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name);

      expect(names).toEqual(
        expect.arrayContaining([
          "_smithers_runs",
          "_smithers_nodes",
          "_smithers_attempts",
          "_smithers_frames",
          "_smithers_approvals",
          "_smithers_human_requests",
          "_smithers_alerts",
          "_smithers_signals",
          "_smithers_cache",
          "_smithers_node_diffs",
          "_smithers_time_travel_audit",
          "_smithers_rewind_leases",
          "_smithers_schema_migrations",
          "_smithers_sandboxes",
          "_smithers_tool_calls",
          "_smithers_tool_call_archive",
          "_smithers_events",
          "_smithers_ralph",
          "_smithers_cron",
          "_smithers_snapshots",
          "_smithers_branches",
          "_smithers_vcs_tags",
          "_smithers_scorers",
          "_smithers_vectors",
          "_smithers_memory_facts",
          "_smithers_memory_threads",
          "_smithers_memory_messages",
          "_smithers_docs",
          "_smithers_workspace_states",
          "_smithers_workspace_checkpoints",
          "_smithers_integration_deliveries",
          "_smithers_integration_cursors",
        ]),
      );
    } finally {
      sqlite.close();
    }
  });

  test("event history treats empty type filters as no filter and clamps zero limits", async () => {
    const { sqlite, adapter } = createAdapter();
    try {
      await adapter.insertEvent({ runId: "run-1", seq: 0, timestampMs: 100, type: "RunStarted", payloadJson: "{}" });
      await adapter.insertEvent({
        runId: "run-1",
        seq: 1,
        timestampMs: 200,
        type: "NodeStarted",
        payloadJson: JSON.stringify({ nodeId: "task-a" }),
      });
      await adapter.insertEvent({
        runId: "run-1",
        seq: 2,
        timestampMs: 300,
        type: "NodeFinished",
        payloadJson: JSON.stringify({ nodeId: "task-a" }),
      });

      const limited = await adapter.listEventHistory("run-1", { types: [], limit: 0 });
      expect(limited.map((row) => row.seq)).toEqual([0]);
      expect(await adapter.countEventHistory("run-1", { types: [] })).toBe(3);
      expect(await adapter.countEventHistory("run-1", { nodeId: "task-a" })).toBe(2);
    } finally {
      sqlite.close();
    }
  });

  test("signal queries compose null correlation, received-after, and defensive limit bounds", async () => {
    const { sqlite, adapter } = createAdapter();
    try {
      await adapter.insertSignalWithNextSeq({
        runId: "run-1",
        signalName: "deploy",
        correlationId: null,
        payloadJson: '{"step":1}',
        receivedAtMs: 100,
        receivedBy: undefined,
      });
      await adapter.insertSignalWithNextSeq({
        runId: "run-1",
        signalName: "deploy",
        correlationId: "c1",
        payloadJson: '{"step":2}',
        receivedAtMs: 200,
        receivedBy: "ui",
      });
      await adapter.insertSignalWithNextSeq({
        runId: "run-1",
        signalName: "deploy",
        correlationId: null,
        payloadJson: '{"step":3}',
        receivedAtMs: 300,
        receivedBy: null,
      });

      const rows = await adapter.listSignals("run-1", {
        signalName: "deploy",
        correlationId: null,
        receivedAfterMs: 250,
        limit: 0,
      });
      expect(rows.map((row) => row.seq)).toEqual([2]);
      expect(await adapter.getLastSignalSeq("run-1")).toBe(2);
    } finally {
      sqlite.close();
    }
  });

  test("listDocs uses strict updatedAfter semantics and clamps empty limits to one row", async () => {
    const { sqlite, adapter } = createAdapter();
    try {
      await adapter.upsertDoc({
        path: "tickets/a.md",
        kind: "ticket",
        content: "a",
        contentHash: "hash-a",
        status: "open",
        updatedAtMs: 100,
        deletedAtMs: null,
      });
      await adapter.upsertDoc({
        path: "tickets/b.md",
        kind: "ticket",
        content: "b",
        contentHash: "hash-b",
        status: "open",
        updatedAtMs: 200,
        deletedAtMs: null,
      });
      await adapter.upsertDoc({
        path: "tickets/c.md",
        kind: "ticket",
        content: "c",
        contentHash: "hash-c",
        status: "open",
        updatedAtMs: 300,
        deletedAtMs: 300,
      });

      const live = await adapter.listDocs({ kind: "ticket", updatedAfterMs: 100, limit: 0 });
      expect(live.map((row) => row.path)).toEqual(["tickets/b.md"]);

      const deleted = await adapter.listDocs({ kind: "ticket", includeDeleted: true, updatedAfterMs: 200 });
      expect(deleted.map((row) => row.path)).toEqual(["tickets/c.md"]);
    } finally {
      sqlite.close();
    }
  });

  test("human request terminal states are guarded from later answer or reopen writes", async () => {
    const { sqlite, adapter } = createAdapter();
    try {
      await adapter.insertHumanRequest(humanRequestRow());
      await adapter.cancelHumanRequest("human-1");
      await adapter.answerHumanRequest("human-1", '{"ok":true}', 200, "will");
      await adapter.reopenHumanRequest("human-1");

      const cancelled = await adapter.getHumanRequest("human-1");
      expect(cancelled?.status).toBe("cancelled");
      expect(cancelled?.responseJson).toBeNull();

      await adapter.insertHumanRequest(humanRequestRow({ requestId: "human-2" }));
      await adapter.answerHumanRequest("human-2", '{"ok":true}', 300, "will");
      await adapter.cancelHumanRequest("human-2");
      expect((await adapter.getHumanRequest("human-2"))?.status).toBe("answered");
    } finally {
      sqlite.close();
    }
  });

  test("alert validation rejects invalid rows and listAlerts clamps zero limits", async () => {
    const { sqlite, adapter } = createAdapter();
    try {
      expect(() => adapter.insertAlert(alertRow({ alertId: "bad-severity", severity: "urgent" }))).toThrow(
        /Alert severity/,
      );
      expect(() => adapter.insertAlert(alertRow({ alertId: "bad-status", status: "open" }))).toThrow(/Alert status/);
      expect(() => adapter.listAlerts(100, ["open"])).toThrow(/Alert status/);

      await adapter.insertAlert(alertRow({ alertId: "newer", firedAtMs: 2_000 }));
      await adapter.insertAlert(alertRow({ alertId: "older", firedAtMs: 1_000 }));

      const limited = await adapter.listAlerts(0);
      expect(limited.map((row) => row.alertId)).toEqual(["newer"]);

      const unfiltered = await adapter.listAlerts(100, []);
      expect(unfiltered.map((row) => row.alertId)).toEqual(["newer", "older"]);
    } finally {
      sqlite.close();
    }
  });

  test("payload-only output rows validate and persist through the row helpers", async () => {
    const sqlite = new Database(":memory:");
    try {
      const schema = z.object({ payload: z.string() });
      const table = zodToTable("payload_only_output", schema);
      sqlite.exec(zodToCreateTableSQL("payload_only_output", schema));
      const db = drizzle(sqlite, { schema: { payloadOnlyOutput: table } });

      const row = buildOutputRow(table, "run-1", "node-1", 0, "plain-text-result");
      const validation = validateOutput(table, row);
      expect(validation.ok).toBe(true);

      await upsertOutputRow(db, table, { runId: "run-1", nodeId: "node-1", iteration: 0 }, validation.data);
      const selected = await selectOutputRow(db, table, { runId: "run-1", nodeId: "node-1", iteration: 0 });

      expect(selected).toMatchObject({
        runId: "run-1",
        nodeId: "node-1",
        iteration: 0,
        payload: "plain-text-result",
      });
    } finally {
      sqlite.close();
    }
  });
});
