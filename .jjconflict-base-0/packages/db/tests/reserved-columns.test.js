import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { zodToCreateTableSQL } from "../src/zodToCreateTableSQL.js";
import { zodToTable } from "../src/zodToTable.js";
import { assertNoReservedColumns } from "../src/assertNoReservedColumns.js";

describe("assertNoReservedColumns", () => {
  test("output schema rejects nodeId / runId / iteration (camelCase and snake)", () => {
    for (const field of ["nodeId", "runId", "iteration", "node_id", "run_id"]) {
      expect(() => assertNoReservedColumns(z.object({ [field]: z.string() }), "t")).toThrow(/reserved field name/);
    }
  });

  test("input schema rejects only runId, not nodeId/iteration", () => {
    expect(() => assertNoReservedColumns(z.object({ runId: z.string() }), "input", { isInput: true })).toThrow(/reserved field name/);
    // nodeId / iteration are NOT reserved on input tables (only run_id is the PK).
    expect(() => assertNoReservedColumns(z.object({ nodeId: z.string() }), "input", { isInput: true })).not.toThrow();
    expect(() => assertNoReservedColumns(z.object({ iteration: z.number() }), "input", { isInput: true })).not.toThrow();
  });

  test("non-reserved fields are allowed", () => {
    expect(() => assertNoReservedColumns(z.object({ targetNodeId: z.string(), score: z.number() }), "t")).not.toThrow();
  });
});

describe("table builders reject reserved columns instead of corrupting", () => {
  test("zodToCreateTableSQL throws a named error rather than emitting a duplicate column", () => {
    expect(() => zodToCreateTableSQL("my_node", z.object({ nodeId: z.string() }))).toThrow(/reserved field name/);
    // Sanity: the previously-broken DDL would have had a duplicate node_id and
    // crashed SQLite — confirm a valid schema still produces runnable DDL.
    const sql = zodToCreateTableSQL("ok_node", z.object({ value: z.string() }));
    const db = new Database(":memory:");
    expect(() => db.run(sql)).not.toThrow();
    db.close();
  });

  test("zodToTable throws rather than silently overwriting the internal key column", () => {
    expect(() => zodToTable("my_node", z.object({ nodeId: z.number() }))).toThrow(/reserved field name/);
  });
});
