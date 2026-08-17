import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { SmithersDb } from "@smthrs/db/adapter";
import { countRecentRewindAuditRows } from "../src/countRecentRewindAuditRows.js";
import { evaluateRewindRateLimit } from "../src/evaluateRewindRateLimit.js";
import { listRewindAuditRows } from "../src/listRewindAuditRows.js";
import { updateRewindAuditRow } from "../src/updateRewindAuditRow.js";
import { writeRewindAuditRow } from "../src/writeRewindAuditRow.js";
import { expandResetSet } from "../src/fork/_helpers.js";

function setupDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

async function seedRun(adapter: SmithersDb, runId = "run-1") {
  await adapter.insertRun({
    runId,
    workflowName: "wf",
    status: "running",
    createdAtMs: 1,
  });
}

async function writeAudit(adapter: SmithersDb, overrides: Partial<Parameters<typeof writeRewindAuditRow>[1]> = {}) {
  return writeRewindAuditRow(adapter, {
    runId: "run-1",
    fromFrameNo: 5,
    toFrameNo: 2,
    caller: "user:owner",
    timestampMs: 1_000,
    result: "success",
    durationMs: 10,
    ...overrides,
  });
}

describe("rewind audit helpers", () => {
  test("counts only terminal rows for the caller and window", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter);
      await writeAudit(adapter, { timestampMs: 900, result: "success" });
      await writeAudit(adapter, { timestampMs: 950, result: "failed" });
      await writeAudit(adapter, { timestampMs: 980, result: "in_progress" });
      await writeAudit(adapter, { timestampMs: 990, caller: "user:other" });
      await writeAudit(adapter, { timestampMs: 100, result: "partial" });

      await expect(
        countRecentRewindAuditRows(adapter, {
          runId: "run-1",
          caller: "user:owner",
          sinceMs: 800,
        }),
      ).resolves.toBe(2);
    } finally {
      sqlite.close();
    }
  });

  test("evaluates quota with normalized max/window values", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter);
      await writeAudit(adapter, { timestampMs: 900 });
      await writeAudit(adapter, { timestampMs: 950 });

      const result = await evaluateRewindRateLimit({
        adapter,
        runId: "run-1",
        caller: "user:owner",
        nowMs: () => 1_000,
        maxPerWindow: 2,
        windowMs: 200,
      });

      expect(result).toEqual({
        limited: true,
        used: 2,
        remaining: 0,
        max: 2,
        windowMs: 200,
        windowStartedAtMs: 800,
      });
    } finally {
      sqlite.close();
    }
  });

  test("updates result, duration, and optional from frame", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter);
      const inserted = await writeAudit(adapter, {
        fromFrameNo: 8,
        result: "in_progress",
        durationMs: null,
      });

      await updateRewindAuditRow(adapter, {
        id: inserted ?? -1,
        result: "partial",
        durationMs: 250,
        fromFrameNo: 6,
      });

      const rows = await listRewindAuditRows(adapter, { runId: "run-1" });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: inserted,
        result: "partial",
        durationMs: 250,
        fromFrameNo: 6,
      });
    } finally {
      sqlite.close();
    }
  });
});

describe("expandResetSet", () => {
  const nodes = {
    "task-a::0": {},
    "task-a::1": {},
    "task-b::0": {},
    "task-b::1": {},
  };

  test("falls back to exact keys when reset IDs are not base node IDs", () => {
    expect(expandResetSet(nodes, ["task-b::1"])).toEqual(["task-b::1"]);
  });

  test("a base node ID resets every iteration of that node", () => {
    expect(expandResetSet(nodes, ["task-a"]).toSorted()).toEqual(["task-a::0", "task-a::1"]);
  });

  // Contract pin: fork resets ONLY the named nodes. `task-b` consumes `task-a`
  // downstream, and naming `task-a` must never drag it in — callers that want a
  // dependent re-run name it themselves. Flipping this back to the docstring's
  // old "full transitive set including all downstream dependents" claim, or to
  // an "iteration >= min iteration" threshold, fails here.
  test("never expands to downstream dependents or to peers at the same iteration", () => {
    expect(expandResetSet(nodes, ["task-a"])).not.toContain("task-b::0");
    expect(expandResetSet(nodes, ["task-a::0"])).toEqual(["task-a::0"]);
    expect(expandResetSet(nodes, ["task-a", "task-b"]).toSorted()).toEqual([
      "task-a::0",
      "task-a::1",
      "task-b::0",
      "task-b::1",
    ]);
  });

  test("matches each reset ID independently, mixing base IDs and exact keys", () => {
    expect(expandResetSet(nodes, ["task-a", "task-b::1"]).toSorted()).toEqual(["task-a::0", "task-a::1", "task-b::1"]);
  });

  test("ignores reset IDs that match nothing, and an empty reset list", () => {
    expect(expandResetSet(nodes, [])).toEqual([]);
    expect(expandResetSet(nodes, ["ghost", "ghost::7"])).toEqual([]);
    expect(expandResetSet(nodes, ["ghost", "task-b::0"])).toEqual(["task-b::0"]);
  });
});
