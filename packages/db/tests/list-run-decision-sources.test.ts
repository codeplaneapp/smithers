import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";

function database() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

describe("run decision source readers", () => {
  test("lists every target-run human status, joins labels, orders, and expires stale pending rows", async () => {
    const { adapter } = database();
    await adapter.insertRun({ runId: "run-a", workflowName: "workflow", status: "running", createdAtMs: 1 });
    await adapter.insertRun({ runId: "run-b", workflowName: "workflow", status: "running", createdAtMs: 1 });
    await adapter.insertNode({ runId: "run-a", nodeId: "ask", iteration: 0, state: "waiting", updatedAtMs: 1, outputTable: "out", label: "Ask operator" });
    const row = (requestId: string, status: string, requestedAtMs: number, extra = {}) => ({ requestId, runId: "run-a", nodeId: "ask", iteration: 0, kind: "ask", status, prompt: requestId, schemaJson: null, optionsJson: null, responseJson: null, requestedAtMs, answeredAtMs: null, answeredBy: null, timeoutAtMs: null, ...extra });
    await adapter.insertHumanRequest(row("expired", "pending", 10, { timeoutAtMs: 50 }));
    await adapter.insertHumanRequest(row("answered", "answered", 20, { answeredAtMs: 25, answeredBy: "cli" }));
    await adapter.insertHumanRequest(row("cancelled", "cancelled", 30));
    await adapter.insertHumanRequest({ ...row("other", "pending", 1), runId: "run-b" });

    const rows = await adapter.listHumanRequestsForRun("run-a", 100);
    expect(rows.map((entry: any) => entry.requestId)).toEqual(["expired", "answered", "cancelled"]);
    expect(rows.map((entry: any) => entry.status)).toEqual(["expired", "answered", "cancelled"]);
    expect(rows[0].nodeLabel).toBe("Ask operator");
  });

  test("returns only provenance-stamped facts for the requested run", async () => {
    const { sqlite, adapter } = database();
    sqlite.run("INSERT INTO _smithers_memory_facts (namespace, key, value_json, created_at_ms, updated_at_ms, run_id, node_id, iteration) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ["ns", "target", "true", 1, 20, "run-a", "node-a", 2]);
    sqlite.run("INSERT INTO _smithers_memory_facts (namespace, key, value_json, created_at_ms, updated_at_ms, run_id) VALUES (?, ?, ?, ?, ?, ?)", ["ns", "other", "false", 1, 10, "run-b"]);
    sqlite.run("INSERT INTO _smithers_memory_facts (namespace, key, value_json, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)", ["ns", "legacy", "null", 1, 5]);

    const rows = await adapter.listMemoryFactsForRun("run-a");
    expect(rows).toEqual([expect.objectContaining({ key: "target", runId: "run-a", nodeId: "node-a", iteration: 2 })]);
  });
});
