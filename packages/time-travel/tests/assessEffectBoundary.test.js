import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { assessEffectBoundary } from "../src/assessEffectBoundary.js";

function setup() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

function insertEffect(sqlite, row, archived) {
  const columns = [
    "run_id", "node_id", "iteration", "attempt", "seq", "tool_name",
    "input_json", "output_json", "started_at_ms", "finished_at_ms", "status",
    "error_json", "kind", "side_effect", "idempotent",
    "accepts_idempotency_key", "has_revert", "idempotency_key",
    "revert_status", "reverted_at_ms", "revert_error_json", "forced_past_json",
  ];
  const values = [
    row.runId, row.nodeId, 0, 1, row.seq, row.toolName,
    "{}", "{}", row.startedAtMs, row.startedAtMs + 1, row.status,
    null, row.legacy ? null : "tool", row.legacy ? null : 1,
    row.legacy ? null : Number(row.idempotent),
    row.legacy ? null : 0, row.legacy ? null : Number(row.hasRevert), null,
    row.revertStatus ?? null, null, null,
    row.forced ? '[{"opId":"prior"}]' : null,
  ];
  if (archived) {
    columns.push("archived_by_op", "archived_at_ms", "archive_reason");
    values.push("prior-op", 999, "prior discard");
  }
  const placeholders = columns.map(() => "?").join(", ");
  sqlite.query(
    `INSERT INTO ${archived ? "_smithers_tool_call_archive" : "_smithers_tool_calls"}
       (${columns.join(", ")}) VALUES (${placeholders})`,
  ).run(...values);
}

describe("assessEffectBoundary", () => {
  test("covers status x idempotent x hasRevert x archived x forced x legacy-null-flags", async () => {
    const { sqlite, adapter } = setup();
    const statuses = ["succeeded", "unknown", "intended", "failed", "reverted"];
    let seq = 0;
    const expected = { blocking: [], revertible: [], warnings: [] };

    for (const status of statuses) {
      for (const idempotent of [false, true]) {
        for (const hasRevert of [false, true]) {
          for (const archived of [false, true]) {
            for (const forced of [false, true]) {
              for (const legacy of [false, true]) {
                seq += 1;
                const toolName = `effect-${seq}`;
                insertEffect(sqlite, {
                  runId: "matrix",
                  nodeId: `node-${seq}`,
                  seq,
                  toolName,
                  startedAtMs: 100 + seq,
                  status,
                  idempotent,
                  hasRevert,
                  forced,
                  legacy,
                }, archived);
                const active = status === "succeeded"
                  || status === "unknown"
                  || status === "intended"
                  || status === "failed";
                if (!active) continue;
                if (archived || legacy) {
                  expected.warnings.push(toolName);
                } else if (hasRevert) {
                  expected.revertible.push(toolName);
                } else {
                  expected.blocking.push(toolName);
                }
              }
            }
          }
        }
      }
    }

    const report = await assessEffectBoundary(adapter, { runId: "matrix", cutoffMs: 0 });
    expect(report.blocking.map((row) => row.toolName).sort()).toEqual(expected.blocking.sort());
    expect(report.revertible.map((row) => row.toolName).sort()).toEqual(expected.revertible.sort());
    expect(report.warnings.map((row) => row.toolName).sort()).toEqual(expected.warnings.sort());
    expect(report.blocking.some((row) => row.idempotent)).toBe(true);
    expect(report.blocking.some((row) => row.reason?.includes("forced"))).toBe(false);
    sqlite.close();
  });

  test("keeps legacy rows warning-only and treats failed or stuck rows conservatively", async () => {
    const { sqlite, adapter } = setup();
    insertEffect(sqlite, {
      runId: "legacy", nodeId: "legacy-node", seq: 1, toolName: "legacy-tool",
      startedAtMs: 200, status: "succeeded", idempotent: false,
      hasRevert: false, forced: false, legacy: true,
    }, false);
    insertEffect(sqlite, {
      runId: "legacy", nodeId: "retry-node", seq: 2, toolName: "retry-tool",
      startedAtMs: 300, status: "succeeded", idempotent: false,
      hasRevert: true, forced: false, legacy: false, revertStatus: "reverting",
    }, false);
    insertEffect(sqlite, {
      runId: "legacy", nodeId: "done-node", seq: 3, toolName: "done-tool",
      startedAtMs: 400, status: "succeeded", idempotent: false,
      hasRevert: true, forced: false, legacy: false, revertStatus: "reverted",
    }, false);
    insertEffect(sqlite, {
      runId: "legacy", nodeId: "failed-node", seq: 4, toolName: "failed-tool",
      startedAtMs: 500, status: "succeeded", idempotent: false,
      hasRevert: true, forced: false, legacy: false, revertStatus: "revert-failed",
    }, false);

    const report = await assessEffectBoundary(adapter, {
      runId: "legacy",
      attempts: [
        { nodeId: "legacy-node", iteration: 0, attempt: 1 },
        { nodeId: "retry-node", iteration: 0, attempt: 1 },
        { nodeId: "done-node", iteration: 0, attempt: 1 },
        { nodeId: "failed-node", iteration: 0, attempt: 1 },
      ],
      toolMetadata: new Map([["legacy-tool", {
        name: "legacy-tool", sideEffect: true, idempotent: true, hasRevert: true,
      }]]),
    });

    expect(report.revertible.map((row) => [row.toolName, row.effectStatus])).toEqual([
      ["failed-tool", "unknown"],
      ["retry-tool", "unknown"],
    ]);
    expect(report.blocking).toEqual([]);
    expect(report.warnings.map((row) => [row.toolName, row.effectStatus])).toEqual([
      ["legacy-tool", "succeeded"],
    ]);
    expect(report.warnings[0]?.reason).toContain("warning-only");
    sqlite.close();
  });

  test("treats compensated-then-completed revert-stale rows as active", async () => {
    const { sqlite, adapter } = setup();
    insertEffect(sqlite, {
      runId: "revert-stale", nodeId: "blocking", seq: 1, toolName: "unrevertible",
      startedAtMs: 100, status: "succeeded", idempotent: false,
      hasRevert: false, forced: false, legacy: false, revertStatus: "revert-stale",
    }, false);
    insertEffect(sqlite, {
      runId: "revert-stale", nodeId: "revertible", seq: 2, toolName: "revertible",
      startedAtMs: 200, status: "succeeded", idempotent: false,
      hasRevert: true, forced: false, legacy: false, revertStatus: "revert-stale",
    }, false);

    const report = await assessEffectBoundary(adapter, {
      runId: "revert-stale",
      cutoffMs: 0,
    });

    expect(report.blocking.map((row) => [row.toolName, row.effectStatus])).toEqual([
      ["unrevertible", "succeeded"],
    ]);
    expect(report.revertible.map((row) => [row.toolName, row.effectStatus])).toEqual([
      ["revertible", "succeeded"],
    ]);
    expect(report.warnings).toEqual([]);
    sqlite.close();
  });

  test("flagged failed and stuck-started rows block while legacy failed rows warn", async () => {
    const { sqlite, adapter } = setup();
    insertEffect(sqlite, {
      runId: "unsafe-statuses", nodeId: "failed", seq: 1, toolName: "flagged-failed",
      startedAtMs: 100, status: "failed", idempotent: false,
      hasRevert: false, forced: false, legacy: false,
    }, false);
    insertEffect(sqlite, {
      runId: "unsafe-statuses", nodeId: "started", seq: 2, toolName: "flagged-started",
      startedAtMs: 200, status: "started", idempotent: false,
      hasRevert: false, forced: false, legacy: false,
    }, false);
    insertEffect(sqlite, {
      runId: "unsafe-statuses", nodeId: "legacy-failed", seq: 3, toolName: "legacy-failed",
      startedAtMs: 300, status: "failed", idempotent: false,
      hasRevert: false, forced: false, legacy: true,
    }, false);

    const report = await assessEffectBoundary(adapter, {
      runId: "unsafe-statuses",
      cutoffMs: 0,
      toolMetadata: new Map([["legacy-failed", {
        name: "legacy-failed",
        sideEffect: true,
        idempotent: false,
        hasRevert: false,
      }]]),
    });

    expect(report.blocking.map((row) => [row.toolName, row.effectStatus])).toEqual([
      ["flagged-started", "unknown"],
      ["flagged-failed", "unknown"],
    ]);
    expect(report.warnings.map((row) => [row.toolName, row.effectStatus])).toEqual([
      ["legacy-failed", "unknown"],
    ]);
    expect(report.revertible).toEqual([]);
    sqlite.close();
  });

  test("current registry side-effect metadata never upgrades a legacy row into a blocker or revert", async () => {
    const { sqlite, adapter } = setup();
    insertEffect(sqlite, {
      runId: "legacy-registry", nodeId: "legacy", seq: 1, toolName: "legacy-now-effectful",
      startedAtMs: 100, status: "succeeded", idempotent: false,
      hasRevert: false, forced: false, legacy: true,
    }, false);

    const report = await assessEffectBoundary(adapter, {
      runId: "legacy-registry",
      cutoffMs: 0,
      toolMetadata: new Map([["legacy-now-effectful", {
        name: "legacy-now-effectful",
        sideEffect: true,
        idempotent: false,
        hasRevert: true,
      }]]),
    });

    expect(report.blocking).toEqual([]);
    expect(report.revertible).toEqual([]);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatchObject({
      toolName: "legacy-now-effectful",
      hasRevert: true,
    });
    sqlite.close();
  });

  test("selects only the cutoff or exact attempt discard set", async () => {
    const { sqlite, adapter } = setup();
    for (const [seq, startedAtMs] of [[1, 100], [2, 200], [3, 300]]) {
      insertEffect(sqlite, {
        runId: "selection", nodeId: `node-${seq}`, seq, toolName: `tool-${seq}`,
        startedAtMs, status: "succeeded", idempotent: false,
        hasRevert: false, forced: false, legacy: false,
      }, false);
    }
    const cutoff = await assessEffectBoundary(adapter, { runId: "selection", cutoffMs: 200 });
    expect(cutoff.blocking.map((row) => row.toolName)).toEqual(["tool-3", "tool-2"]);
    const exact = await assessEffectBoundary(adapter, {
      runId: "selection",
      attempts: [{ nodeId: "node-1", iteration: 0, attempt: 1 }],
    });
    expect(exact.blocking.map((row) => row.toolName)).toEqual(["tool-1"]);
    sqlite.close();
  });
});
