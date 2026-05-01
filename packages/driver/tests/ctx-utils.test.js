import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { buildCurrentScopes } from "../src/buildCurrentScopes.js";
import { filterRowsByNodeId } from "../src/filterRowsByNodeId.js";
import { ignoreSyncError } from "../src/ignoreSyncError.js";
import { normalizeInputRow } from "../src/normalizeInputRow.js";
import { SmithersCtx } from "../src/SmithersCtx.js";
import {
  getTaskRuntime,
  requireTaskRuntime,
  withTaskRuntime,
} from "../src/task-runtime.js";
import { withAbort } from "../src/withAbort.js";
import { withLogicalIterationShortcuts } from "../src/withLogicalIterationShortcuts.js";

function makeCtx(overrides = {}) {
  return new SmithersCtx({
    runId: "run-1",
    iteration: 0,
    input: {},
    outputs: {},
    ...overrides,
  });
}

const numberSchema = {
  safeParse(value) {
    return typeof value === "number"
      ? { success: true, data: value }
      : { success: false, error: new Error("not number") };
  },
};

describe("normalizeInputRow", () => {
  test("leaves primitives unchanged", () => {
    expect(normalizeInputRow(null)).toBeNull();
    expect(normalizeInputRow("x")).toBe("x");
    expect(normalizeInputRow(1)).toBe(1);
  });

  test("leaves objects without payload unchanged", () => {
    const input = { runId: "r1", value: 1 };
    expect(normalizeInputRow(input)).toBe(input);
  });

  test("leaves rows with extra keys unchanged", () => {
    const input = { runId: "r1", payload: "{}", extra: true };
    expect(normalizeInputRow(input)).toBe(input);
  });

  test("nullish payload normalizes to empty object", () => {
    expect(normalizeInputRow({ runId: "r1", payload: null })).toEqual({});
    expect(normalizeInputRow({ runId: "r1", payload: undefined })).toEqual({});
  });

  test("JSON object payload is parsed", () => {
    expect(normalizeInputRow({ payload: '{"a":1}' })).toEqual({ a: 1 });
  });

  test("JSON array payload is parsed", () => {
    expect(normalizeInputRow({ payload: "[1,2,3]" })).toEqual([1, 2, 3]);
  });

  test("invalid JSON string payload is returned as a string", () => {
    expect(normalizeInputRow({ payload: "{nope" })).toBe("{nope");
  });

  test("non-string payload is returned directly", () => {
    const payload = { nested: true };
    expect(normalizeInputRow({ runId: "r1", payload })).toBe(payload);
  });
});

describe("filterRowsByNodeId", () => {
  const rows = [
    { nodeId: "task", iteration: 0, value: "exact-0" },
    { nodeId: "task", iteration: 1, value: "exact-1" },
    { nodeId: "task@@outer=1", iteration: 0, value: "scoped-1" },
    { nodeId: "task@@outer=1,inner=2", iteration: 0, value: "scoped-deep" },
    { nodeId: "other", iteration: 0, value: "other" },
  ];

  test("returns exact rows first", () => {
    expect(filterRowsByNodeId(rows, "task", new Set()).map((r) => r.value))
      .toEqual(["exact-0", "exact-1"]);
  });

  test("exact rows win over scoped fallback", () => {
    expect(
      filterRowsByNodeId(rows, "task", new Set(["@@outer=1"])).map((r) => r.value),
    ).toEqual(["exact-0", "exact-1"]);
  });

  test("falls back to scoped rows when exact rows are absent", () => {
    const scopedOnly = rows.filter((row) => row.nodeId !== "task");
    expect(
      filterRowsByNodeId(scopedOnly, "task", new Set(["@@outer=1"])).map(
        (r) => r.value,
      ),
    ).toEqual(["scoped-1"]);
  });

  test("uses the longest matching current scope first", () => {
    const scopedOnly = rows.filter((row) => row.nodeId !== "task");
    expect(
      filterRowsByNodeId(
        scopedOnly,
        "task",
        new Set(["@@outer=1", "@@outer=1,inner=2"]),
      ).map((r) => r.value),
    ).toEqual(["scoped-deep"]);
  });

  test("scoped lookup id does not fallback to other scopes", () => {
    expect(
      filterRowsByNodeId(rows, "task@@outer=2", new Set(["@@outer=1"])),
    ).toEqual([]);
  });

  test("returns empty array for missing node id", () => {
    expect(filterRowsByNodeId(rows, "none", new Set())).toEqual([]);
  });
});

describe("iteration scope helpers", () => {
  test("buildCurrentScopes returns empty set without iterations", () => {
    expect(buildCurrentScopes()).toEqual(new Set());
  });

  test("buildCurrentScopes ignores unscoped ids", () => {
    expect(buildCurrentScopes({ outer: 2 })).toEqual(new Set());
  });

  test("buildCurrentScopes rewrites ancestor iterations to current values", () => {
    expect(buildCurrentScopes({ outer: 3, "inner@@outer=1": 4 }))
      .toEqual(new Set(["@@outer=3"]));
  });

  test("buildCurrentScopes preserves unknown ancestor scope parts", () => {
    expect(buildCurrentScopes({ "inner@@outer=1": 4 }))
      .toEqual(new Set(["@@outer=1"]));
  });

  test("buildCurrentScopes skips malformed scope parts", () => {
    expect(buildCurrentScopes({ "inner@@outer": 4 })).toEqual(new Set());
  });

  test("buildCurrentScopes handles multiple ancestors", () => {
    expect(
      buildCurrentScopes({
        outer: 2,
        middle: 5,
        "inner@@outer=1,middle=4": 7,
      }),
    ).toEqual(new Set(["@@outer=2,middle=5"]));
  });

  test("withLogicalIterationShortcuts returns undefined unchanged", () => {
    expect(withLogicalIterationShortcuts()).toBeUndefined();
  });

  test("withLogicalIterationShortcuts returns unscoped-only object unchanged", () => {
    const iterations = { outer: 2 };
    expect(withLogicalIterationShortcuts(iterations)).toBe(iterations);
  });

  test("withLogicalIterationShortcuts maps current scoped id to logical id", () => {
    expect(withLogicalIterationShortcuts({ outer: 2, "inner@@outer=2": 7 }))
      .toEqual({ outer: 2, "inner@@outer=2": 7, inner: 7 });
  });

  test("withLogicalIterationShortcuts leaves stale scoped id at logical zero", () => {
    expect(withLogicalIterationShortcuts({ outer: 3, "inner@@outer=2": 7 }))
      .toEqual({ outer: 3, "inner@@outer=2": 7, inner: 0 });
  });

  test("withLogicalIterationShortcuts handles malformed scope as non-current", () => {
    expect(withLogicalIterationShortcuts({ "inner@@outer": 7 }))
      .toEqual({ "inner@@outer": 7, inner: 0 });
  });
});

describe("SmithersCtx output access", () => {
  test("normalizes input payload rows in constructor", () => {
    const ctx = makeCtx({ input: { runId: "r1", payload: '{"ok":true}' } });
    expect(ctx.input).toEqual({ ok: true });
  });

  test("exposes outputs as callable accessor and named properties", () => {
    const rows = [{ nodeId: "a", iteration: 0, value: 1 }];
    const ctx = makeCtx({ outputs: { rows } });
    expect(ctx.outputs("rows")).toBe(rows);
    expect(ctx.outputs.rows).toBe(rows);
  });

  test("output returns exact node and iteration row", () => {
    const ctx = makeCtx({
      outputs: { rows: [{ nodeId: "a", iteration: 0, value: 1 }] },
    });
    expect(ctx.output("rows", { nodeId: "a", iteration: 0 }).value).toBe(1);
  });

  test("output throws clear SmithersError when row is missing", () => {
    const ctx = makeCtx({ outputs: { rows: [] } });
    expect(() => ctx.output("rows", { nodeId: "missing", iteration: 0 }))
      .toThrow(/Missing output/);
  });

  test("outputMaybe returns undefined when row is missing", () => {
    const ctx = makeCtx({ outputs: { rows: [] } });
    expect(ctx.outputMaybe("rows", { nodeId: "missing", iteration: 0 }))
      .toBeUndefined();
  });

  test("resolveRow defaults missing key iteration to current iteration", () => {
    const ctx = makeCtx({
      iteration: 2,
      outputs: { rows: [{ nodeId: "a", iteration: 2, value: "current" }] },
    });
    expect(ctx.output("rows", { nodeId: "a" }).value).toBe("current");
  });

  test("latest picks highest numeric iteration", () => {
    const ctx = makeCtx({
      outputs: {
        rows: [
          { nodeId: "a", iteration: 0, value: "zero" },
          { nodeId: "a", iteration: 2, value: "two" },
          { nodeId: "a", iteration: 1, value: "one" },
        ],
      },
    });
    expect(ctx.latest("rows", "a").value).toBe("two");
  });

  test("latest treats missing iteration as zero", () => {
    const ctx = makeCtx({
      outputs: { rows: [{ nodeId: "a", value: "zero" }] },
    });
    expect(ctx.latest("rows", "a").value).toBe("zero");
  });

  test("iterationCount counts distinct numeric iterations", () => {
    const ctx = makeCtx({
      outputs: {
        rows: [
          { nodeId: "a", iteration: 0 },
          { nodeId: "a", iteration: 0 },
          { nodeId: "a", iteration: 1 },
          { nodeId: "a", iteration: "bad" },
        ],
      },
    });
    expect(ctx.iterationCount("rows", "a")).toBe(2);
  });

  test("zod table map resolves non-string table references", () => {
    const schema = {};
    const ctx = makeCtx({
      zodToKeyName: new Map([[schema, "rows"]]),
      outputs: { rows: [{ nodeId: "a", iteration: 0, value: 1 }] },
    });
    expect(ctx.output(schema, { nodeId: "a", iteration: 0 }).value).toBe(1);
  });

  test("drizzle-style table metadata resolves table name", () => {
    const ctx = makeCtx({
      outputs: { rows: [{ nodeId: "a", iteration: 0, value: 1 }] },
    });
    expect(ctx.output({ _: { name: "rows" } }, { nodeId: "a", iteration: 0 }).value)
      .toBe(1);
  });

  test("direct table name property resolves table name", () => {
    const ctx = makeCtx({
      outputs: { rows: [{ nodeId: "a", iteration: 0, value: 1 }] },
    });
    expect(ctx.output({ name: "rows" }, { nodeId: "a", iteration: 0 }).value)
      .toBe(1);
  });

  test("scoped output fallback uses current loop scope", () => {
    const ctx = makeCtx({
      iterations: { outer: 2, "inner@@outer=1": 0 },
      outputs: {
        rows: [{ nodeId: "task@@outer=2", iteration: 0, value: "scoped" }],
      },
    });
    expect(ctx.output("rows", { nodeId: "task", iteration: 0 }).value).toBe("scoped");
  });

  test("exact output beats scoped fallback in context lookups", () => {
    const ctx = makeCtx({
      iterations: { outer: 2, "inner@@outer=1": 0 },
      outputs: {
        rows: [
          { nodeId: "task", iteration: 0, value: "exact" },
          { nodeId: "task@@outer=2", iteration: 0, value: "scoped" },
        ],
      },
    });
    expect(ctx.output("rows", { nodeId: "task", iteration: 0 }).value).toBe("exact");
  });
});

describe("SmithersCtx latestArray", () => {
  test("returns empty array for nullish values", () => {
    const ctx = makeCtx();
    expect(ctx.latestArray(null, numberSchema)).toEqual([]);
    expect(ctx.latestArray(undefined, numberSchema)).toEqual([]);
  });

  test("parses JSON arrays and filters invalid entries", () => {
    const ctx = makeCtx();
    expect(ctx.latestArray("[1,\"x\",2]", numberSchema)).toEqual([1, 2]);
  });

  test("wraps JSON objects as a single candidate", () => {
    const ctx = makeCtx();
    expect(ctx.latestArray("3", numberSchema)).toEqual([3]);
  });

  test("returns empty array for invalid JSON strings", () => {
    const ctx = makeCtx();
    expect(ctx.latestArray("{bad", numberSchema)).toEqual([]);
  });

  test("wraps scalar non-string values", () => {
    const ctx = makeCtx();
    expect(ctx.latestArray(4, numberSchema)).toEqual([4]);
  });
});

describe("task runtime and async helpers", () => {
  test("getTaskRuntime returns undefined outside runtime scope", () => {
    expect(getTaskRuntime()).toBeUndefined();
  });

  test("requireTaskRuntime throws outside runtime scope", () => {
    expect(() => requireTaskRuntime()).toThrow(/task runtime is only available/);
  });

  test("withTaskRuntime scopes runtime to callback", () => {
    const runtime = { nodeId: "task-1", iteration: 0 };
    const result = withTaskRuntime(runtime, () => requireTaskRuntime());
    expect(result).toBe(runtime);
    expect(getTaskRuntime()).toBeUndefined();
  });

  test("withAbort resolves completed values", async () => {
    await expect(withAbort(Promise.resolve("ok"))).resolves.toBe("ok");
  });

  test("withAbort rejects when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(withAbort(new Promise(() => {}), controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  test("withAbort rejects pending work on later abort", async () => {
    const controller = new AbortController();
    const promise = withAbort(new Promise(() => {}), controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  test("ignoreSyncError swallows cleanup errors", async () => {
    await expect(
      Effect.runPromise(
        ignoreSyncError("cleanup", () => {
          throw new Error("cleanup failed");
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
