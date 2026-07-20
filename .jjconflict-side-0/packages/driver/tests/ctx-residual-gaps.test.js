import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { SmithersCtx } from "../src/SmithersCtx.js";

function makeCtx(overrides = {}) {
  return new SmithersCtx({
    runId: "run-1",
    iteration: 0,
    input: {},
    outputs: {},
    ...overrides,
  });
}

describe("SmithersCtx.latest tie-breaking", () => {
  test("for two rows at the same iteration the later snapshot row wins", () => {
    // Retried attempts append their row after the original, so `iter >=
    // bestIteration` (not `>`) must let the newer row of a tied iteration win.
    const ctx = makeCtx({
      outputs: {
        tbl: [
          { runId: "run-1", nodeId: "n", iteration: 1, v: "first-write" },
          { runId: "run-1", nodeId: "n", iteration: 1, v: "retry-write" },
        ],
      },
    });
    expect(ctx.latest("tbl", "n")).toEqual({ v: "retry-write" });
  });

  test("a tied lower iteration never displaces a higher one", () => {
    const ctx = makeCtx({
      outputs: {
        tbl: [
          { runId: "run-1", nodeId: "n", iteration: 2, v: "high" },
          { runId: "run-1", nodeId: "n", iteration: 0, v: "low-a" },
          { runId: "run-1", nodeId: "n", iteration: 0, v: "low-b" },
        ],
      },
    });
    expect(ctx.latest("tbl", "n")).toEqual({ v: "high" });
  });
});

describe("SmithersCtx.resolveTableName last-resort fallback", () => {
  test("an unregistered zod schema stringifies instead of resolving a table", () => {
    // A schema constructed inline (never registered via createSmithers) has no
    // zodToKeyName entry and no drizzle metadata, so it falls back to
    // String(table). Pin that junk name so a future refactor that starts
    // resolving these differently is a deliberate change.
    const schema = z.object({ v: z.number() });
    const ctx = makeCtx({
      outputs: { real: [{ runId: "run-1", nodeId: "n", iteration: 0, v: 1 }] },
    });
    const resolved = ctx.resolveTableName(schema);
    expect(typeof resolved).toBe("string");
    expect(resolved).not.toBe("real");
    // The misresolved name means lookups miss and surface as MISSING_OUTPUT.
    expect(() => ctx.output(schema, { nodeId: "n" })).toThrow(/Missing output/);
    expect(ctx.outputMaybe(schema, { nodeId: "n" })).toBeUndefined();
  });

  test("an object with neither drizzle metadata nor a name stringifies", () => {
    const ctx = makeCtx();
    expect(ctx.resolveTableName({ _: {} })).toBe("[object Object]");
  });
});

describe("SmithersCtx.iterations scoped shortcuts through the constructor", () => {
  test("a current scoped id is exposed under its logical id", () => {
    const ctx = makeCtx({
      iterations: { outer: 2, "inner@@outer=2": 7 },
    });
    expect(ctx.iterations.inner).toBe(7);
    expect(ctx.iterations.outer).toBe(2);
  });

  test("a stale scoped id resolves the logical id to 0", () => {
    const ctx = makeCtx({
      iterations: { outer: 3, "inner@@outer=2": 7 },
    });
    expect(ctx.iterations.inner).toBe(0);
  });
});

describe("SmithersCtx.auth default", () => {
  test("omitted auth defaults to null, not undefined", () => {
    expect(makeCtx().auth).toBeNull();
  });
});
