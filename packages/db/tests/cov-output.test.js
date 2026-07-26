import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { z } from "zod";
import {
  buildOutputRow,
  stripAutoColumns,
  getKeyColumns,
  buildKeyWhere,
  selectOutputRow,
  upsertOutputRow,
  selectOutputRowEffect,
  upsertOutputRowEffect,
  validateOutput,
  validateExistingOutput,
  getAgentOutputSchema,
  describeSchemaShape,
} from "../src/output.js";
import { zodToTable } from "../src/zodToTable.js";
import { zodToCreateTableSQL } from "../src/zodToCreateTableSQL.js";

/** @param {string} name @param {z.ZodObject<any>} schema */
function tableAndDb(name, schema) {
  const table = zodToTable(name, schema);
  const sqlite = new Database(":memory:");
  sqlite.exec(zodToCreateTableSQL(name, schema));
  const db = drizzle(sqlite, { schema: { [name]: table } });
  return { table, db, sqlite };
}

describe("output.js pure helpers", () => {
  test("buildOutputRow: payload-only table vs column-mapped table", () => {
    const payloadTable = zodToTable("pl", z.object({ payload: z.string() }));
    expect(buildOutputRow(payloadTable, "r", "n", 0, "hi")).toEqual({
      runId: "r",
      nodeId: "n",
      iteration: 0,
      payload: "hi",
    });
    expect(buildOutputRow(payloadTable, "r", "n", 0, undefined)).toEqual({
      runId: "r",
      nodeId: "n",
      iteration: 0,
      payload: null,
    });
    const colTable = zodToTable("c", z.object({ a: z.string(), b: z.number() }));
    expect(buildOutputRow(colTable, "r", "n", 2, { a: "x", b: 3 })).toEqual({
      a: "x",
      b: 3,
      runId: "r",
      nodeId: "n",
      iteration: 2,
    });
  });

  test("stripAutoColumns: object strips keys; non-objects pass through", () => {
    expect(stripAutoColumns({ runId: "r", nodeId: "n", iteration: 0, __smithersProvenanceSeq: 42, keep: 1 })).toEqual({
      keep: 1,
    });
    expect(stripAutoColumns(null)).toBeNull();
    expect(stripAutoColumns([1])).toEqual([1]);
    expect(stripAutoColumns(7)).toBe(7);
  });

  test("getKeyColumns + buildKeyWhere; missing key columns throw", () => {
    const table = zodToTable("k", z.object({ a: z.string() }));
    const cols = getKeyColumns(table);
    expect(cols.runId).toBeDefined();
    expect(buildKeyWhere(table, { runId: "r", nodeId: "n", iteration: 0 })).toBeDefined();
    const inputTable = zodToTable("ki", z.object({ a: z.string() }), { isInput: true });
    expect(() => getKeyColumns(inputTable)).toThrow(/must include runId and nodeId/);
  });

  test("getAgentOutputSchema drops key columns; validate ok/error paths", () => {
    const table = zodToTable("v", z.object({ a: z.string(), b: z.number() }));
    expect(Object.keys(getAgentOutputSchema(table).shape).sort()).toEqual(["a", "b"]);
    expect(validateOutput(table, { runId: "r", nodeId: "n", iteration: 0, a: "x", b: 1 }).ok).toBe(true);
    expect(validateOutput(table, { runId: "r", nodeId: "n", iteration: 0, a: 5, b: 1 }).ok).toBe(false);
    expect(validateExistingOutput(table, { runId: "r", nodeId: "n", iteration: 0, a: "x", b: 1 }).ok).toBe(true);
    expect(validateExistingOutput(table, { runId: "r", nodeId: "n", iteration: 0, a: "x", b: "no" }).ok).toBe(false);
  });
});

describe("output.js select/upsert (sqlite)", () => {
  test("upsert then select round-trips via the Promise + Effect entry points", async () => {
    const { table, db, sqlite } = tableAndDb("o", z.object({ summary: z.string() }));
    try {
      await upsertOutputRow(db, table, { runId: "r", nodeId: "n", iteration: 0 }, { summary: "hello" });
      const row = await selectOutputRow(db, table, { runId: "r", nodeId: "n", iteration: 0 });
      expect(row.summary).toBe("hello");
      const row2 = await Effect.runPromise(selectOutputRowEffect(db, table, { runId: "r", nodeId: "n", iteration: 0 }));
      expect(row2.summary).toBe("hello");
    } finally {
      sqlite.close();
    }
  });

  test("select + upsert surface DB errors (missing physical table) through the catch branch", async () => {
    const table = zodToTable("no_table", z.object({ summary: z.string() }));
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite, { schema: { no_table: table } });
    try {
      await expect(selectOutputRow(db, table, { runId: "r", nodeId: "n", iteration: 0 })).rejects.toThrow();
      const upExit = await Effect.runPromiseExit(
        upsertOutputRowEffect(db, table, { runId: "r", nodeId: "n", iteration: 0 }, { summary: "x" }),
      );
      expect(upExit._tag).toBe("Failure");
    } finally {
      sqlite.close();
    }
  });
});

describe("output.js describeSchemaShape", () => {
  test("JSON-schema fast path for a zod object and for a drizzle table", () => {
    expect(typeof describeSchemaShape(z.object({ x: z.string() }))).toBe("string");
    const table = zodToTable("d", z.object({ a: z.string(), b: z.number() }));
    expect(typeof describeSchemaShape(table)).toBe("string");
    // Explicit zodSchema arg overrides tableOrSchema.
    expect(typeof describeSchemaShape(table, z.object({ y: z.number() }))).toBe("string");
  });

  test("fallback describeZodType covers every instanceof branch", () => {
    // A z.bigint() field makes JSON-schema conversion throw, forcing the
    // per-field describeZodType walk that uses instanceof checks.
    const out = describeSchemaShape(
      z.object({
        big: z.bigint(),
        s: z.string(),
        n: z.number(),
        i: z.int(),
        b: z.boolean(),
        arr: z.array(z.string()),
        obj: z.object({ y: z.string() }),
        en: z.enum(["a", "b"]),
        lit: z.literal("x"),
        uni: z.union([z.string(), z.number()]),
        opt: z.string().optional(),
        nul: z.string().nullable(),
        def: z.string().default("d"),
      }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.s).toBe("string");
    expect(parsed.n).toBe("number");
    expect(parsed.i).toBe("number");
    expect(parsed.b).toBe("boolean");
    expect(parsed.arr).toBe("string[]");
    expect(parsed.obj).toBe("object");
    expect(parsed.en).toContain("enum(");
    expect(parsed.lit).toContain("literal(");
    expect(parsed.uni).toBe("string | number");
    expect(parsed.opt).toBe("string (optional)");
    expect(parsed.nul).toBe("string | null");
    expect(parsed.def).toBe("string");
    expect(parsed.big).toBe("unknown");
  });

  test("fallback describeZodType reaches the _zod.def branch for non-instanceof types", () => {
    // record/date/tuple fall through every instanceof check into the
    // `internal._zod.def` block and resolve to "unknown" via the fallthrough.
    const out = describeSchemaShape(
      z.object({
        big: z.bigint(),
        rec: z.record(z.string(), z.number()),
        dt: z.date(),
        tup: z.tuple([z.string()]),
      }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.rec).toBe("unknown");
    expect(parsed.dt).toBe("unknown");
  });
});
