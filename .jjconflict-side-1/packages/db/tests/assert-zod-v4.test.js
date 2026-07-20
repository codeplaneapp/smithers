import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { assertZodV4 } from "@smithers-orchestrator/errors/assertZodV4";
import { zodToTable } from "../src/zodToTable.js";

// Real-zod integration: a genuine Zod v4 schema must pass, and a v3-shaped schema
// must be rejected with a clear error at the zodToTable boundary instead of
// silently degrading every column to JSON text and crashing later.
describe("assertZodV4 with real zod", () => {
  test("accepts genuine Zod v4 schemas of every kind", () => {
    expect(() => assertZodV4(z.object({ x: z.string() }))).not.toThrow();
    expect(() => assertZodV4(z.string())).not.toThrow();
    expect(() => assertZodV4(z.number().optional())).not.toThrow();
    expect(() => assertZodV4(z.array(z.boolean()))).not.toThrow();
    expect(() => assertZodV4(z.enum(["a", "b"]))).not.toThrow();
  });

  test("zodToTable still builds a table from a real v4 schema", () => {
    expect(() =>
      zodToTable("ok_table", z.object({ name: z.string(), score: z.number() })),
    ).not.toThrow();
  });

  test("zodToTable rejects a Zod v3-shaped schema with an actionable error", () => {
    const v3 = { _def: { typeName: "ZodObject" }, shape: { x: {} }, parse() {} };
    expect(() => zodToTable("bad_table", v3)).toThrow(/requires Zod v4/);
  });
});
