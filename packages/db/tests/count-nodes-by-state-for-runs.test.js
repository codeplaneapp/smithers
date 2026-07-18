import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";

function createAdapter() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), sqlite };
}

function node(runId, nodeId, state) {
  return { runId, nodeId, iteration: 0, state, updatedAtMs: 1, outputTable: "out", label: null };
}
function insert(sqlite, rows) {
  const statement = sqlite.prepare("INSERT INTO _smithers_nodes (run_id, node_id, iteration, state, updated_at_ms, output_table, label) VALUES (?, ?, 0, ?, 1, 'out', NULL)");
  sqlite.transaction(() => { for (const row of rows) statement.run(row.runId, row.nodeId, row.state); })();
}

describe("countNodesByStateForRuns", () => {
  test("matches per-run counts and returns camelCase runId rows", async () => {
    const { adapter, sqlite } = createAdapter();
    try {
      insert(sqlite, [node("one", "a", "finished"), node("one", "b", "failed"), node("two", "a", "pending"), node("three", "a", "cancelled")]);
      const batch = await adapter.countNodesByStateForRuns(["one", "two"]);
      const one = await adapter.countNodesByState("one");
      const two = await adapter.countNodesByState("two");
      expect(batch).toEqual([
        ...one.map(({ state, count }) => ({ runId: "one", state, count })),
        ...two.map(({ state, count }) => ({ runId: "two", state, count })),
      ]);
      expect(batch.every((row) => typeof row.runId === "string" && !("run_id" in row))).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  test("does not query for an empty requested set and excludes other runs", async () => {
    const { adapter, sqlite } = createAdapter();
    try {
      insert(sqlite, [node("wanted", "a", "failed"), node("other", "a", "finished")]);
      expect(await adapter.countNodesByStateForRuns([])).toEqual([]);
      expect(await adapter.countNodesByStateForRuns(["wanted"])).toEqual([{ runId: "wanted", state: "failed", count: 1 }]);
    } finally {
      sqlite.close();
    }
  });

  test("chunks more than SQLite's bind limit", async () => {
    const { adapter, sqlite } = createAdapter();
    try {
      const ids = Array.from({ length: 1001 }, (_, index) => `run-${index}`);
      insert(sqlite, ids.map((id) => node(id, "n", "finished")));
      const rows = await adapter.countNodesByStateForRuns(ids);
      expect(rows).toHaveLength(1001);
      expect(rows.every((row) => row.state === "finished" && row.count === 1)).toBe(true);
    } finally {
      sqlite.close();
    }
  });
});
