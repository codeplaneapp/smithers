import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";

function setup() {
  const sqlite = new Database(":memory:");
  ensureSmithersTables(drizzle(sqlite));
  return { sqlite, adapter: new SmithersDb(drizzle(sqlite)) };
}

function run(runId, extra = {}) {
  return { runId, workflowName: "wf", status: "running", createdAtMs: Date.now(), ...extra };
}

describe("run ownership", () => {
  test("scoped reads use the persisted owner/app pair while unscoped reads remain compatible", async () => {
    const { adapter } = setup();
    await adapter.insertRun(run("a", { owner: "alice", app: "arb" }));
    await adapter.insertRun(run("b", { owner: "bob", app: "arb" }));
    await adapter.insertRun(run("legacy"));

    expect(
      (await adapter.listRuns(50, undefined, undefined, { ownership: { owner: "alice", app: "arb" } })).map(
        (r) => r.runId,
      ),
    ).toEqual(["a"]);
    expect(await adapter.getRun("a", { owner: "bob", app: "arb" })).toBeUndefined();
    expect((await adapter.listRuns()).map((r) => r.runId).sort()).toEqual(["a", "b", "legacy"]);
    expect((await adapter.listRuns(50, undefined, undefined, { unownedOnly: true })).map((r) => r.runId)).toEqual([
      "legacy",
    ]);
  });

  test("children inherit ownership and cannot override their parent", async () => {
    const { adapter } = setup();
    await adapter.insertRun(run("parent", { owner: "alice", app: "arb" }));
    await adapter.insertRun(run("child", { parentRunId: "parent" }));
    expect(await adapter.getRun("child")).toMatchObject({ owner: "alice", app: "arb" });
    let error;
    try {
      await adapter.insertRun(run("bad-child", { parentRunId: "parent", owner: "bob", app: "arb" }));
    } catch (cause) {
      error = cause;
    }
    expect(String(error)).toContain("inherit");
    error = undefined;
    try {
      await adapter.updateRun("child", { owner: "bob", app: "arb" });
    } catch (cause) {
      error = cause;
    }
    expect(String(error)).toContain("immutable");
    error = undefined;
    try {
      await adapter.insertRun(run("parent", { owner: "bob", app: "arb" }));
    } catch (cause) {
      error = cause;
    }
    expect(String(error)).toContain("already exists");
    expect(await adapter.getRun("parent")).toMatchObject({ owner: "alice", app: "arb" });
  });

  test("owner/app filtering is backed by the composite index", async () => {
    const { sqlite } = setup();
    const indexes = sqlite
      .query('PRAGMA index_list("_smithers_runs")')
      .all()
      .map((row) => row.name);
    expect(indexes).toContain("_smithers_runs_owner_app_created_idx");
    const plan = sqlite
      .query(
        "EXPLAIN QUERY PLAN SELECT * FROM _smithers_runs WHERE owner = ? AND app = ? ORDER BY created_at_ms DESC LIMIT ?",
      )
      .all("alice", "arb", 50)
      .map((row) => String(row.detail));
    expect(plan.some((detail) => detail.includes("_smithers_runs_owner_app_created_idx"))).toBe(true);
  });
});
