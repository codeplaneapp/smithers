import { describe, expect, test } from "bun:test";
import { capCostFetchSet, foldWorkspaceCost, runIdOf, runsStartedTodayOf } from "../src/monitor-ui/monitorOpsModel.ts";

describe("monitor operations model", () => {
  test("selects local-day starts with camel and snake case fallbacks", () => {
    const now = new Date(2026, 6, 18, 12).getTime();
    const midnight = new Date(2026, 6, 18).getTime();
    const rows = [
      { runId: "camel", startedAtMs: midnight },
      { runId: "snake", started_at_ms: midnight + 1 },
      { runId: "created", createdAtMs: now },
      { runId: "old", startedAtMs: midnight - 1 },
    ] as any[];
    expect(runsStartedTodayOf(rows, now).map((row) => row.runId)).toEqual(["camel", "snake", "created"]);
  });

  test("caps unique cost requests", () => {
    expect(capCostFetchSet(["a", "b", "a", "c"], 2)).toEqual({ runIds: ["a", "b"], skippedCount: 1 });
  });

  test("reads camel and snake case run ids", () => {
    expect(runIdOf({ runId: "camel" })).toBe("camel");
    expect(runIdOf({ run_id: "snake" } as any)).toBe("snake");
  });

  test("folds priced, unpriced, failed, and skipped envelopes honestly", () => {
    const priced = { ok: true, data: { totals: { costUsd: 1.25 }, groups: [{ model: "x", priced: true, costUsd: 1.25 }] } };
    const unpriced = { ok: true, data: { totals: { costUsd: 0 }, groups: [{ model: "unknown", priced: false }] } };
    expect(foldWorkspaceCost([{ body: priced }, { body: unpriced }, { failed: true }], 2)).toEqual({
      totalUsd: 1.25, pricedRuns: 1, unpricedRuns: 1, failedRuns: 1, fetchedCount: 3, skippedCount: 2,
    });
  });
});
