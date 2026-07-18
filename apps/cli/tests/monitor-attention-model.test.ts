import { describe, expect, test } from "bun:test";
import { diagnoseRun } from "../src/monitor-ui/monitorModel.ts";
import { diagnoseRunLite, failedTaskCountOf, isGuardTaskId, STALE_ENGINE_AFTER_MS, workspaceAttention } from "../src/monitor-ui/monitorAttentionModel.ts";

describe("monitor attention model", () => {
  test("counts failed states from tolerant summaries only", () => {
    expect(failedTaskCountOf({ runId: "r", summary: { failed: 2, cancelled: 9 } })).toBe(2);
    expect(failedTaskCountOf({ runId: "r", summary: JSON.stringify({ cancelled: 9 }) })).toBe(0);
    expect(failedTaskCountOf({ runId: "r" })).toBeUndefined();
    expect(failedTaskCountOf({ runId: "r", summary: "bad json" })).toBeUndefined();
  });
  test("keeps the selected-run guard convention in parity", () => {
    expect(isGuardTaskId("guard:root")).toBe(true); expect(isGuardTaskId("verify:queue-guard")).toBe(true); expect(isGuardTaskId("plain")).toBe(false);
    expect(diagnoseRun({ runId: "r", status: "failed", approvalsCount: 0, treeNodes: [{ id: "verify:guard", status: "failed" }] }).headline).toContain("guard");
  });
  test("diagnoses failures, quota, stale and orphaned rows", () => {
    expect(diagnoseRunLite({ runId: "r", status: "failed", error_json: '{"message":"boom"}' } as never, [], 1)[0]).toMatchObject({ kind: "failed", tone: "crit", detail: "boom" });
    expect(diagnoseRunLite({ runId: "r", status: "failed", errorJson: '{"message":"guard:root failed"}' }, [], 1)[0].kind).toBe("guard");
    expect(diagnoseRunLite({ runId: "r", status: "waiting-quota", errorJson: '{"quotaBlockedCount":2,"resetAtMs":9}' }, [], 1)[0]).toMatchObject({ kind: "quota", count: 2, resetAtMs: 9 });
    expect(diagnoseRunLite({ runId: "r", status: "waiting-quota", errorJson: '{"quotaBlockedCount":1}' }, [], 1)[0]).toMatchObject({ kind: "quota", count: 1 });
    expect(diagnoseRunLite({ run_id: "r", status: "waiting_quota", error_json: '{"quotaBlockedCount":1,"resetAtMs":9}' } as never, [], 1)[0]).toMatchObject({ kind: "quota", count: 1, resetAtMs: 9 });
    expect(diagnoseRunLite({ runId: "r", status: "continued", heartbeatAtMs: 1 }, [], 1 + STALE_ENGINE_AFTER_MS)).toEqual([]);
    expect(diagnoseRunLite({ runId: "r", status: "running", heartbeatAtMs: 1 }, [], 1 + STALE_ENGINE_AFTER_MS)).toEqual([]);
    expect(diagnoseRunLite({ runId: "r", status: "orphaned" }, [], 1)[0].headline).toContain("orphaned");
  });
  test("uses tolerant row keys and only calls old heartbeat-less active runs orphaned", () => {
    expect(diagnoseRunLite({ run_id: "snake", status: "running", heartbeat_at_ms: 1, created_at_ms: 1 } as never, [], 2 + STALE_ENGINE_AFTER_MS)[0]).toMatchObject({ runId: "snake", kind: "stale-engine" });
    expect(diagnoseRunLite({ run_id: "owned", status: "running", heartbeat_at_ms: 1, runtime_owner_id: "pid:1" } as never, [], 2 + STALE_ENGINE_AFTER_MS)[0]).toMatchObject({ headline: "Engine heartbeat is stale" });
    expect(diagnoseRunLite({ runId: "young", status: "running", createdAtMs: 1 }, [], STALE_ENGINE_AFTER_MS).some((item) => item.kind === "stale-engine")).toBe(false);
    expect(diagnoseRunLite({ runId: "old", status: "running", createdAtMs: 1 }, [], 2 + STALE_ENGINE_AFTER_MS)[0]).toMatchObject({ kind: "stale-engine", headline: "Run may be orphaned" });
    expect(diagnoseRunLite({ runId: "bad", status: "failed", errorJson: "not-json" }, [], 1)[0]).toMatchObject({ kind: "failed", tone: "crit" });
  });
  test("aggregates approvals and does not hide them behind another diagnosis", () => {
    const items = workspaceAttention(
      [{ runId: "r", status: "failed", summary: { failed: 2 } }],
      [{ runId: "r", requestedAtMs: 8 }, { run_id: "r", requested_at_ms: 3 }],
      10,
    ).items;
    expect(items.map((item) => item.kind)).toEqual(["failed", "approvals"]);
    expect(items[1]).toMatchObject({ count: 2, atMs: 3 });
  });
  test("sorts critical first and reports honest totals", () => {
    const result = workspaceAttention([{ runId: "warn", status: "finished", summary: { failed: 1 }, createdAtMs: 2 }, { runId: "crit", status: "failed", errorJson: '{"message":"nope"}', createdAtMs: 1 }], [], 10);
    expect(result.items.map((item) => item.runId)).toEqual(["crit", "warn"]);
    expect(result).toMatchObject({ total: 2, countsByKind: { failed: 1, "failed-tasks": 1 } });
    expect(workspaceAttention([], [], 1)).toMatchObject({ total: 0, items: [] });
  });
  test("does not double-report failed tasks for a failed run and leaves clean terminal rows alone", () => {
    expect(diagnoseRunLite({ runId: "failed", status: "failed", summary: { failed: 2 } }, [], 1).map((item) => item.kind)).toEqual(["failed"]);
    expect(diagnoseRunLite({ runId: "clean", status: "finished", summary: { finished: 2 } }, [], 1)).toEqual([]);
    expect(diagnoseRunLite({ runId: "task-failure", status: "finished", summary: { failed: 2 } }, [], 1)[0]).toMatchObject({ kind: "failed-tasks", count: 2 });
  });
});
