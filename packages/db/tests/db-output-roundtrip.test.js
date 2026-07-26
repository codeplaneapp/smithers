import { describe, expect, test } from "bun:test";
import { selectOutputRow, upsertOutputRow, getAgentOutputSchema, validateOutput } from "../src/output.js";
import { zodToTable } from "../src/zodToTable.js";
import { zodToCreateTableSQL } from "../src/zodToCreateTableSQL.js";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
/**
 * @param {string} name
 * @param {z.ZodObject<any>} zodSchema
 */
function createTableAndDb(name, zodSchema) {
  const table = zodToTable(name, zodSchema);
  const sqlite = new Database(":memory:");
  sqlite.exec(zodToCreateTableSQL(name, zodSchema));
  const db = drizzle(sqlite, { schema: { [name]: table } });
  return { table, db, sqlite };
}
describe("output row roundtrip", () => {
  test("upsert then select returns the same data", async () => {
    const { table, db, sqlite } = createTableAndDb("results", z.object({ summary: z.string(), score: z.number() }));
    try {
      await upsertOutputRow(
        db,
        table,
        { runId: "r1", nodeId: "n1", iteration: 0 },
        {
          summary: "Test result",
          score: 95,
        },
      );
      const row = await selectOutputRow(db, table, {
        runId: "r1",
        nodeId: "n1",
        iteration: 0,
      });
      expect(row).toBeDefined();
      expect(row.summary).toBe("Test result");
      expect(row.score).toBe(95);
      expect(row.runId).toBe("r1");
      expect(row.nodeId).toBe("n1");
    } finally {
      sqlite.close();
    }
  });
  test("z.number() round-trips a fractional value losslessly (REAL column, not INTEGER)", async () => {
    const { table, db, sqlite } = createTableAndDb(
      "fractional",
      z.object({ confidence: z.number(), cost: z.number() }),
    );
    try {
      // Regression for #296/#312: a plain z.number() must map to a REAL
      // column so 0.95 is not truncated to 0 by SQLite INTEGER affinity.
      expect(table.confidence.getSQLType()).toBe("real");
      await upsertOutputRow(
        db,
        table,
        { runId: "r1", nodeId: "n1", iteration: 0 },
        {
          confidence: 0.95,
          cost: 0.0123,
        },
      );
      const row = await selectOutputRow(db, table, { runId: "r1", nodeId: "n1", iteration: 0 });
      expect(row.confidence).toBe(0.95);
      expect(row.cost).toBe(0.0123);
    } finally {
      sqlite.close();
    }
  });
  test("upsert overwrites existing row on conflict", async () => {
    const { table, db, sqlite } = createTableAndDb("results", z.object({ value: z.number() }));
    try {
      const key = { runId: "r1", nodeId: "n1", iteration: 0 };
      await upsertOutputRow(db, table, key, { value: 1 });
      await upsertOutputRow(db, table, key, { value: 2 });
      const row = await selectOutputRow(db, table, key);
      expect(row.value).toBe(2);
    } finally {
      sqlite.close();
    }
  });
  test("select returns undefined for missing row", async () => {
    const { table, db, sqlite } = createTableAndDb("results", z.object({ value: z.number() }));
    try {
      const row = await selectOutputRow(db, table, {
        runId: "nonexistent",
        nodeId: "n1",
        iteration: 0,
      });
      expect(row).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });
  test("multiple rows with different nodeIds", async () => {
    const { table, db, sqlite } = createTableAndDb("results", z.object({ label: z.string() }));
    try {
      await upsertOutputRow(db, table, { runId: "r1", nodeId: "a", iteration: 0 }, { label: "first" });
      await upsertOutputRow(db, table, { runId: "r1", nodeId: "b", iteration: 0 }, { label: "second" });
      const rowA = await selectOutputRow(db, table, {
        runId: "r1",
        nodeId: "a",
        iteration: 0,
      });
      const rowB = await selectOutputRow(db, table, {
        runId: "r1",
        nodeId: "b",
        iteration: 0,
      });
      expect(rowA.label).toBe("first");
      expect(rowB.label).toBe("second");
    } finally {
      sqlite.close();
    }
  });
  test("multiple iterations for same nodeId", async () => {
    const { table, db, sqlite } = createTableAndDb("results", z.object({ attempt: z.number() }));
    try {
      await upsertOutputRow(db, table, { runId: "r1", nodeId: "n1", iteration: 0 }, { attempt: 1 });
      await upsertOutputRow(db, table, { runId: "r1", nodeId: "n1", iteration: 1 }, { attempt: 2 });
      const row0 = await selectOutputRow(db, table, {
        runId: "r1",
        nodeId: "n1",
        iteration: 0,
      });
      const row1 = await selectOutputRow(db, table, {
        runId: "r1",
        nodeId: "n1",
        iteration: 1,
      });
      expect(row0.attempt).toBe(1);
      expect(row1.attempt).toBe(2);
    } finally {
      sqlite.close();
    }
  });
  test("malformed JSON row rejects with the SyntaxError reachable via cause", async () => {
    const { table, db, sqlite } = createTableAndDb("results", z.object({ payload: z.object({ ok: z.boolean() }) }));
    try {
      sqlite.exec("INSERT INTO results (run_id, node_id, iteration, payload) VALUES ('r1', 'n1', 0, '{not json')");
      let caught;
      try {
        await selectOutputRow(db, table, { runId: "r1", nodeId: "n1", iteration: 0 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      // The rejection must be the SmithersError itself, not a FiberFailure
      // that severs the cause chain — consumers (getNodeOutput's
      // looksLikeMalformedOutputRow) walk `cause` to find the SyntaxError.
      let sawSyntaxError = false;
      for (let current = caught, depth = 0; current != null && depth < 8; depth += 1) {
        if (current instanceof SyntaxError) {
          sawSyntaxError = true;
          break;
        }
        current = current.cause;
      }
      expect(sawSyntaxError).toBe(true);
    } finally {
      sqlite.close();
    }
  });
});
describe("getAgentOutputSchema", () => {
  test("strips system columns from schema", () => {
    const { table } = createTableAndDb("test", z.object({ title: z.string(), count: z.number() }));
    const agentSchema = getAgentOutputSchema(table);
    const shape = agentSchema.shape;
    expect(shape).toHaveProperty("title");
    expect(shape).toHaveProperty("count");
    expect(shape).not.toHaveProperty("runId");
    expect(shape).not.toHaveProperty("nodeId");
    expect(shape).not.toHaveProperty("iteration");
  });
});
describe("validateOutput edge cases", () => {
  test("validates optional fields", () => {
    const zodSchema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });
    const { table } = createTableAndDb("test", zodSchema);
    const result = validateOutput(table, {
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      required: "value",
      // optional field omitted
    });
    expect(result.ok).toBe(true);
  });
  test("rejects wrong type for field", () => {
    const zodSchema = z.object({ count: z.number() });
    const { table } = createTableAndDb("test", zodSchema);
    const result = validateOutput(table, {
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      count: "not a number",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
