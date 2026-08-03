import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { SmithersCtx } from "../src/SmithersCtx.js";

// Regression pins for #1486: `ctx.outputs(outputs.probe)` — the output-ref
// argument form used everywhere else in the API — silently returned `[]`
// because the callable accessor indexed the snapshot with the raw argument.
// A workflow that interpolated a dependency's rows into a downstream Task's
// prompt therefore rendered "no rows yet" forever instead of the real data.
describe("ctx.outputs(tableRef) — issue #1486", () => {
  const probeSchema = z.object({ camelCaseField: z.string() });
  const probeRows = [{ camelCaseField: "HELLO", nodeId: "probe", iteration: 0 }];

  function makeCtx() {
    return new SmithersCtx({
      runId: "run-1",
      iteration: 0,
      input: {},
      outputs: { probe: probeRows },
      zodToKeyName: new Map([[probeSchema, "probe"]]),
    });
  }

  test("resolves an output ref to the same rows as the string name", () => {
    const ctx = makeCtx();
    expect(ctx.outputs(probeSchema)).toEqual(probeRows);
    expect(ctx.outputs(probeSchema)).toEqual(ctx.outputs("probe"));
    expect(ctx.outputs.probe).toEqual(probeRows);
  });

  test("interpolating a dependency's rows into a downstream prompt sees the rows", () => {
    const ctx = makeCtx();
    const rows = ctx.outputs(probeSchema) ?? [];
    const prompt = rows.length ? `camelCaseField=${JSON.stringify(rows[0].camelCaseField)}` : "no rows yet";
    expect(prompt).toBe('camelCaseField="HELLO"');
  });

  test("a table with no rows yet is still an empty array, not an error", () => {
    const ctx = makeCtx();
    expect(ctx.outputs("report")).toEqual([]);
  });

  test("an argument that resolves to no declared output table throws instead of returning []", () => {
    const ctx = makeCtx();
    expect(() => ctx.outputs({ not: "a table" })).toThrow(/does not resolve to a declared output table/);
  });
});
