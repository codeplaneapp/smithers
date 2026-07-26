import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assessEffectBoundary } from "../src/assessEffectBoundary.js";
import { executeEffectReverts } from "../src/executeEffectReverts.js";
import { archiveDiscardedEffects } from "../src/archiveDiscardedEffects.js";
import { guardEffectBoundary } from "../src/guardEffectBoundary.js";
import { acquireRewindLock } from "../src/acquireRewindLock.js";
import { revertToAttempt } from "../src/revert.js";
import { timeTravel } from "../src/timetravel.js";
import { recordForcedEffectBoundary } from "../src/recordForcedEffectBoundary.js";

function entryHash(workflowPath) {
  return workflowPath
    ? createHash("sha256").update(readFileSync(workflowPath, "utf8")).digest("hex")
    : null;
}

async function setup(runId, workflowPath) {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  const adapter = new SmithersDb(db);
  await adapter.insertRun({
    runId,
    workflowName: "effects",
    workflowPath,
    workflowHash: entryHash(workflowPath),
    status: "finished",
    createdAtMs: 1,
  });
  return { sqlite, adapter };
}

async function insert(adapter, row) {
  await Effect.runPromise(adapter.insertToolCall({
    runId: row.runId,
    nodeId: row.nodeId,
    iteration: 0,
    attempt: row.attempt ?? 1,
    seq: row.seq,
    toolName: row.toolName,
    inputJson: JSON.stringify({ value: row.seq }),
    outputJson: JSON.stringify({ result: row.seq }),
    startedAtMs: row.startedAtMs,
    finishedAtMs: row.startedAtMs + 1,
    status: "succeeded",
    errorJson: null,
    kind: row.kind ?? "tool",
    sideEffect: true,
    idempotent: false,
    acceptsIdempotencyKey: false,
    hasRevert: true,
    idempotencyKey: `key-${row.seq}`,
    revertStatus: null,
    revertedAtMs: null,
    revertErrorJson: null,
    forcedPastJson: null,
  }));
}

describe("effect revert execution", () => {
  test("loads handlers only when recorded workflow identity matches", async () => {
    const workflowPath = fileURLToPath(new URL("./fixtures/effect-boundary-workflow.jsx", import.meta.url));
    const { sqlite, adapter } = await setup("loaded-handlers", workflowPath);
    await insert(adapter, {
      runId: "loaded-handlers", nodeId: "tool-node", seq: 1,
      toolName: "undoable-tool", startedAtMs: 100,
    });
    await insert(adapter, {
      runId: "loaded-handlers", nodeId: "task-node", seq: 0,
      toolName: "task-node", startedAtMs: 200, kind: "task",
    });
    globalThis.__smithersEffectBoundaryReverts = [];

    const boundary = await guardEffectBoundary(adapter, {
      runId: "loaded-handlers",
      cutoffMs: 0,
      operation: "rewind",
      runsReverts: true,
    });

    expect(globalThis.__smithersEffectBoundaryReverts.map((entry) => entry.kind))
      .toEqual(["task", "tool"]);
    expect(globalThis.__smithersEffectBoundaryReverts[1]).toMatchObject({
      input: { value: 1 },
      context: { output: { result: 1 }, effectStatus: "succeeded" },
    });
    expect(boundary.report.revertible.every((effect) => effect.reason === "Reverted successfully."))
      .toBe(true);
    delete globalThis.__smithersEffectBoundaryReverts;
    sqlite.close();
  });

  test("compensates a compute-task defineTool through an exported workflow tool registry", async () => {
    const workflowPath = fileURLToPath(new URL("./fixtures/effect-boundary-workflow.jsx", import.meta.url));
    const { sqlite, adapter } = await setup("compute-tool-handler", workflowPath);
    await insert(adapter, {
      runId: "compute-tool-handler",
      nodeId: "compute-tool-node",
      seq: 1,
      toolName: "compute-undoable-tool",
      startedAtMs: 100,
    });
    globalThis.__smithersEffectBoundaryReverts = [];

    const boundary = await guardEffectBoundary(adapter, {
      runId: "compute-tool-handler",
      cutoffMs: 0,
      operation: "timetravel",
      runsReverts: true,
    });

    expect(globalThis.__smithersEffectBoundaryReverts).toEqual([
      {
        kind: "compute-tool",
        input: { value: 1 },
        context: expect.objectContaining({
          output: { result: 1 },
          effectStatus: "succeeded",
          nodeId: "compute-tool-node",
        }),
      },
    ]);
    expect(boundary.report.revertible).toEqual([
      expect.objectContaining({
        toolName: "compute-undoable-tool",
        reason: "Reverted successfully.",
      }),
    ]);
    delete globalThis.__smithersEffectBoundaryReverts;
    sqlite.close();
  });

  test("workflow identity mismatch blocks compensation without guessing a handler", async () => {
    const workflowPath = fileURLToPath(new URL("./fixtures/effect-boundary-workflow.jsx", import.meta.url));
    const { sqlite, adapter } = await setup("changed-workflow", workflowPath);
    await adapter.updateRun("changed-workflow", { workflowHash: "recorded-before-edit" });
    await insert(adapter, {
      runId: "changed-workflow", nodeId: "tool-node", seq: 1,
      toolName: "undoable-tool", startedAtMs: 100,
    });
    globalThis.__smithersEffectBoundaryReverts = [];

    await expect(guardEffectBoundary(adapter, {
      runId: "changed-workflow",
      cutoffMs: 0,
      operation: "revert",
      runsReverts: true,
    })).rejects.toMatchObject({
      code: "TIME_TRAVEL_SIDE_EFFECT_BLOCKED",
      details: {
        report: {
          blocking: [{
            reason: "workflow changed since the effect was recorded",
          }],
        },
      },
    });
    expect(globalThis.__smithersEffectBoundaryReverts).toEqual([]);
    delete globalThis.__smithersEffectBoundaryReverts;
    sqlite.close();
  });

  test("enforces the operation semantics table before mutating external state", async () => {
    const workflowPath = fileURLToPath(new URL("./fixtures/effect-boundary-workflow.jsx", import.meta.url));
    const cases = [
      { operation: "revert", runsReverts: true, expected: "reverted" },
      { operation: "timetravel", runsReverts: true, expected: "reverted" },
      { operation: "rewind", runsReverts: true, expected: "reverted" },
      { operation: "replay", runsReverts: false, expected: "blocked" },
      { operation: "fork-run", runsReverts: false, expected: "blocked" },
      { operation: "fork", runsReverts: false, warningOnly: true, expected: "warning" },
    ];

    for (const testCase of cases) {
      const runId = `semantics-${testCase.operation}`;
      const { sqlite, adapter } = await setup(runId, workflowPath);
      await insert(adapter, {
        runId, nodeId: "tool-node", seq: 1,
        toolName: "undoable-tool", startedAtMs: 100,
      });
      globalThis.__smithersEffectBoundaryReverts = [];
      if (testCase.expected === "blocked") {
        await expect(guardEffectBoundary(adapter, {
          runId,
          cutoffMs: 0,
          operation: testCase.operation,
          runsReverts: testCase.runsReverts,
        })).rejects.toMatchObject({ code: "TIME_TRAVEL_SIDE_EFFECT_BLOCKED" });
        expect(globalThis.__smithersEffectBoundaryReverts).toEqual([]);
      } else {
        const boundary = await guardEffectBoundary(adapter, {
          runId,
          cutoffMs: 0,
          operation: testCase.operation,
          runsReverts: testCase.runsReverts,
          warningOnly: testCase.warningOnly,
        });
        expect(boundary.report.warnings.length).toBe(testCase.expected === "warning" ? 1 : 0);
        expect(globalThis.__smithersEffectBoundaryReverts.length).toBe(testCase.expected === "reverted" ? 1 : 0);
      }
      sqlite.close();
    }
    delete globalThis.__smithersEffectBoundaryReverts;
  });

  test("unresolvable handlers block before resolved handlers run, while force reverts the resolvable subset", async () => {
    const workflowPath = fileURLToPath(new URL("./fixtures/effect-boundary-workflow.jsx", import.meta.url));
    const { sqlite, adapter } = await setup("unresolved", workflowPath);
    await insert(adapter, {
      runId: "unresolved", nodeId: "tool-node", seq: 1,
      toolName: "undoable-tool", startedAtMs: 100,
    });
    await insert(adapter, {
      runId: "unresolved", nodeId: "missing-node", seq: 2,
      toolName: "missing-tool", startedAtMs: 200,
    });
    globalThis.__smithersEffectBoundaryReverts = [];

    await expect(guardEffectBoundary(adapter, {
      runId: "unresolved",
      cutoffMs: 0,
      operation: "revert",
      runsReverts: true,
    })).rejects.toMatchObject({
      code: "TIME_TRAVEL_SIDE_EFFECT_BLOCKED",
      details: {
        report: {
          blocking: [{
            reason: "The journal records hasRevert=true for tool missing-tool, but no matching defineTool instance was enumerable from task agents or exported workflow tool registries. Closed-over compute-task tools must be exported in a tool registry.",
          }],
        },
      },
    });
    expect(globalThis.__smithersEffectBoundaryReverts).toEqual([]);

    const forced = await guardEffectBoundary(adapter, {
      runId: "unresolved",
      cutoffMs: 0,
      operation: "revert",
      runsReverts: true,
      force: true,
    });
    expect(globalThis.__smithersEffectBoundaryReverts.map((entry) => entry.kind)).toEqual(["tool"]);
    expect(forced.report.blocking).toHaveLength(1);
    expect(forced.forced).toBe(true);
    const forcedRows = sqlite.query(
      `SELECT tool_name, forced_past_json FROM _smithers_tool_calls
        WHERE run_id = ? ORDER BY tool_name`,
    ).all("unresolved");
    expect(forcedRows).toHaveLength(2);
    expect(forcedRows.every((row) => JSON.parse(row.forced_past_json).length === 1)).toBe(true);
    expect(sqlite.query(
      `SELECT type FROM _smithers_events WHERE run_id = ? ORDER BY seq`,
    ).all("unresolved").map((row) => row.type)).toContain("SideEffectBoundaryCrossed");
    const run = await adapter.getRun("unresolved");
    expect(run?.status).toBe("finished");
    expect(run?.finishedAtMs).toBeNull();
    expect(run?.heartbeatAtMs).toBeNull();
    expect(run?.runtimeOwnerId).toBeNull();
    expect(run?.errorJson).toBeNull();
    delete globalThis.__smithersEffectBoundaryReverts;
    sqlite.close();
  });

  test("concurrent forced crossings atomically preserve every row stamp", async () => {
    const { sqlite, adapter } = await setup("concurrent-forced");
    await insert(adapter, {
      runId: "concurrent-forced", nodeId: "tool-node", seq: 1,
      toolName: "undoable-tool", startedAtMs: 100,
    });
    const report = await assessEffectBoundary(adapter, {
      runId: "concurrent-forced",
      cutoffMs: 0,
    });

    await Promise.all([
      recordForcedEffectBoundary(adapter, {
        runId: "concurrent-forced",
        operation: "replay",
        opId: "forced-a",
        report,
      }),
      recordForcedEffectBoundary(adapter, {
        runId: "concurrent-forced",
        operation: "fork-run",
        opId: "forced-b",
        report,
      }),
    ]);

    const row = sqlite.query(
      `SELECT forced_past_json FROM _smithers_tool_calls WHERE run_id = ?`,
    ).get("concurrent-forced");
    expect(JSON.parse(row.forced_past_json).map((entry) => entry.opId).sort())
      .toEqual(["forced-a", "forced-b"]);
    sqlite.close();
  });

  test("forced timetravel leaves the target run running like the unforced path", async () => {
    const { sqlite, adapter } = await setup("forced-timetravel");
    await adapter.insertNode({
      runId: "forced-timetravel",
      nodeId: "target",
      iteration: 0,
      state: "finished",
      lastAttempt: 1,
      updatedAtMs: 100,
      outputTable: "",
      label: null,
    });
    await adapter.insertAttempt({
      runId: "forced-timetravel",
      nodeId: "target",
      iteration: 0,
      attempt: 1,
      state: "finished",
      startedAtMs: 100,
      finishedAtMs: 110,
      jjPointer: null,
    });
    await insert(adapter, {
      runId: "forced-timetravel", nodeId: "target", seq: 1,
      toolName: "unrevertible", startedAtMs: 100,
    });
    await Effect.runPromise(adapter.updateToolCall(
      "forced-timetravel", "target", 0, 1, 1, { hasRevert: false },
    ));

    const result = await timeTravel(adapter, {
      runId: "forced-timetravel",
      nodeId: "target",
      iteration: 0,
      attempt: 1,
      restoreVcs: false,
      force: true,
    });

    expect(result.success).toBe(true);
    expect(await adapter.getRun("forced-timetravel")).toMatchObject({
      status: "running",
      finishedAtMs: null,
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      errorJson: null,
    });
    sqlite.close();
  });

  test("runs compensation in reverse chronological order and journals every transition", async () => {
    const { sqlite, adapter } = await setup("reverse");
    await insert(adapter, { runId: "reverse", nodeId: "old", seq: 1, toolName: "undo", startedAtMs: 100 });
    await insert(adapter, { runId: "reverse", nodeId: "new", seq: 2, toolName: "undo", startedAtMs: 200 });
    const report = await assessEffectBoundary(adapter, { runId: "reverse", cutoffMs: 0 });
    const order = [];
    const events = [];
    const handler = {
      name: "undo", sideEffect: true, idempotent: false, hasRevert: true,
      revert: async (input, context) => order.push([input.value, context.output.result, context.idempotencyKey]),
    };
    const result = await executeEffectReverts(adapter, {
      runId: "reverse",
      operation: "rewind",
      report,
      registry: {
        toolMetadata: new Map([["undo", handler]]),
        tools: new Map([["undo", handler]]),
        tasks: new Map(),
      },
      onProgress: (event) => events.push(event.type),
    });
    expect(order).toEqual([[2, 2, "key-2"], [1, 1, "key-1"]]);
    expect(events).toEqual([
      "EffectRevertStarted", "EffectRevertFinished",
      "EffectRevertStarted", "EffectRevertFinished",
    ]);
    expect(result.revertible.every((effect) => effect.reason === "Reverted successfully.")).toBe(true);
    expect(sqlite.query(
      `SELECT revert_status FROM _smithers_tool_calls WHERE run_id = ? ORDER BY started_at_ms`,
    ).all("reverse")).toEqual([{ revert_status: "reverted" }, { revert_status: "reverted" }]);
    sqlite.close();
  });

  test("late completion while reverting cannot be overwritten as reverted", async () => {
    const { sqlite, adapter } = await setup("stale-during-revert");
    await insert(adapter, {
      runId: "stale-during-revert",
      nodeId: "effect",
      seq: 1,
      toolName: "undo",
      startedAtMs: 100,
    });
    const report = await assessEffectBoundary(adapter, {
      runId: "stale-during-revert",
      cutoffMs: 0,
    });
    const handler = {
      name: "undo",
      sideEffect: true,
      idempotent: false,
      hasRevert: true,
      revert: async () => {
        await Effect.runPromise(adapter.updateToolCall(
          "stale-during-revert",
          "effect",
          0,
          1,
          1,
          {
            status: "succeeded",
            revertStatus: "revert-stale",
          },
        ));
      },
    };

    await expect(executeEffectReverts(adapter, {
      runId: "stale-during-revert",
      operation: "rewind",
      report,
      registry: {
        toolMetadata: new Map([["undo", handler]]),
        tools: new Map([["undo", handler]]),
        tasks: new Map(),
      },
    })).rejects.toMatchObject({
      code: "TIME_TRAVEL_SIDE_EFFECT_BLOCKED",
      details: {
        report: {
          blocking: [{
            reason: expect.stringContaining("revert is stale"),
          }],
          revertible: [],
        },
      },
    });
    expect(sqlite.query(
      `SELECT status, revert_status FROM _smithers_tool_calls WHERE run_id = ?`,
    ).get("stale-during-revert")).toEqual({
      status: "succeeded",
      revert_status: "revert-stale",
    });
    sqlite.close();
  });

  test("revert-failed aborts before truncation and retry re-runs only non-reverted rows", async () => {
    const { sqlite, adapter } = await setup("failure");
    await insert(adapter, { runId: "failure", nodeId: "old", seq: 1, toolName: "undo", startedAtMs: 100 });
    await insert(adapter, { runId: "failure", nodeId: "new", seq: 2, toolName: "undo", startedAtMs: 200 });
    sqlite.exec(`CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('untouched');`);
    const report = await assessEffectBoundary(adapter, { runId: "failure", cutoffMs: 0 });
    const calls = [];
    const failing = {
      name: "undo", sideEffect: true, idempotent: false, hasRevert: true,
      revert: async (input) => {
        calls.push(input.value);
        if (input.value === 1) throw new Error("cannot undo old");
      },
    };
    await expect(executeEffectReverts(adapter, {
      runId: "failure",
      operation: "timetravel",
      report,
      registry: {
        toolMetadata: new Map([["undo", failing]]),
        tools: new Map([["undo", failing]]),
        tasks: new Map(),
      },
    })).rejects.toMatchObject({ code: "TIME_TRAVEL_SIDE_EFFECT_BLOCKED" });
    expect(calls).toEqual([2, 1]);
    expect(sqlite.query(`SELECT value FROM sentinel`).all()).toEqual([{ value: "untouched" }]);
    expect(sqlite.query(
      `SELECT node_id, revert_status FROM _smithers_tool_calls WHERE run_id = ? ORDER BY started_at_ms`,
    ).all("failure")).toEqual([
      { node_id: "old", revert_status: "revert-failed" },
      { node_id: "new", revert_status: "reverted" },
    ]);

    const retryReport = await assessEffectBoundary(adapter, { runId: "failure", cutoffMs: 0 });
    const retryCalls = [];
    const succeeds = { ...failing, revert: async (input) => retryCalls.push(input.value) };
    await executeEffectReverts(adapter, {
      runId: "failure",
      operation: "timetravel",
      report: retryReport,
      registry: {
        toolMetadata: new Map([["undo", succeeds]]),
        tools: new Map([["undo", succeeds]]),
        tasks: new Map(),
      },
    });
    expect(retryCalls).toEqual([1]);
    sqlite.close();
  });

  test("archive move is atomic with discard and prevents attempt-1 journal collisions", async () => {
    const { sqlite, adapter } = await setup("archive");
    await insert(adapter, { runId: "archive", nodeId: "task", attempt: 1, seq: 1, toolName: "undo", startedAtMs: 100 });
    await adapter.withTransaction("archive discard", Effect.gen(function* () {
      yield* Effect.promise(() => archiveDiscardedEffects(adapter, {
        runId: "archive",
        opId: "op-1",
        archivedAtMs: 200,
        archiveReason: "test discard",
        attempts: [{ nodeId: "task", iteration: 0, attempt: 1 }],
      }));
    }));
    expect(sqlite.query(`SELECT * FROM _smithers_tool_calls WHERE run_id = ?`).all("archive")).toEqual([]);
    expect(sqlite.query(
      `SELECT archived_by_op, archive_reason FROM _smithers_tool_call_archive WHERE run_id = ?`,
    ).all("archive")).toEqual([{ archived_by_op: "op-1", archive_reason: "test discard" }]);
    await insert(adapter, { runId: "archive", nodeId: "task", attempt: 1, seq: 1, toolName: "undo", startedAtMs: 300 });
    expect(sqlite.query(`SELECT started_at_ms FROM _smithers_tool_calls WHERE run_id = ?`).all("archive"))
      .toEqual([{ started_at_ms: 300 }]);
    const report = await assessEffectBoundary(adapter, { runId: "archive", cutoffMs: 0 });
    expect(report.revertible).toHaveLength(1);
    expect(report.warnings).toHaveLength(1);
    sqlite.close();
  });

  test("revert and timetravel share the durable rewind lease", async () => {
    const { sqlite, adapter } = await setup("lease-reuse");
    await adapter.insertNode({
      runId: "lease-reuse",
      nodeId: "task",
      iteration: 0,
      state: "finished",
      lastAttempt: 1,
      updatedAtMs: 100,
      outputTable: "",
      label: null,
    });
    await adapter.insertAttempt({
      runId: "lease-reuse",
      nodeId: "task",
      iteration: 0,
      attempt: 1,
      state: "finished",
      startedAtMs: 100,
      finishedAtMs: 110,
      jjPointer: "unused-while-lease-held",
    });
    const lease = await acquireRewindLock(adapter, "lease-reuse");
    expect(lease).not.toBeNull();
    try {
      const reverted = await revertToAttempt(adapter, {
        runId: "lease-reuse",
        nodeId: "task",
        iteration: 0,
        attempt: 1,
      });
      const travelled = await timeTravel(adapter, {
        runId: "lease-reuse",
        nodeId: "task",
        iteration: 0,
        attempt: 1,
        restoreVcs: false,
      });
      expect(reverted).toMatchObject({
        success: false,
        error: "Another time-travel operation is already running for lease-reuse.",
      });
      expect(travelled).toMatchObject({
        success: false,
        error: "Another time-travel operation is already running for lease-reuse.",
      });
      expect(sqlite.query(
        `SELECT run_id FROM _smithers_rewind_leases WHERE run_id = ?`,
      ).all("lease-reuse")).toEqual([{ run_id: "lease-reuse" }]);
    } finally {
      await lease?.release();
      sqlite.close();
    }
  });

  test("lease steal after compensation aborts timetravel before truncation", async () => {
    const workflowPath = fileURLToPath(new URL("./fixtures/effect-boundary-workflow.jsx", import.meta.url));
    const { sqlite, adapter } = await setup("lease-steal-after-compensation", workflowPath);
    await adapter.insertNode({
      runId: "lease-steal-after-compensation",
      nodeId: "target",
      iteration: 0,
      state: "finished",
      lastAttempt: 1,
      updatedAtMs: 110,
      outputTable: "",
      label: null,
    });
    await adapter.insertAttempt({
      runId: "lease-steal-after-compensation",
      nodeId: "target",
      iteration: 0,
      attempt: 1,
      state: "finished",
      startedAtMs: 100,
      finishedAtMs: 110,
      jjPointer: null,
    });
    for (const [frameNo, createdAtMs] of [[0, 50], [1, 150]]) {
      await adapter.insertFrame({
        runId: "lease-steal-after-compensation",
        frameNo,
        createdAtMs,
        xmlJson: "{}",
        xmlHash: `h${frameNo}`,
        mountedTaskIdsJson: "[]",
        taskIndexJson: "[]",
        note: null,
      });
    }
    await insert(adapter, {
      runId: "lease-steal-after-compensation",
      nodeId: "tool-node",
      seq: 1,
      toolName: "undoable-tool",
      startedAtMs: 200,
    });
    globalThis.__smithersEffectBoundaryReverts = [];

    const originalWithTransaction = adapter.withTransaction.bind(adapter);
    adapter.withTransaction = async (label, effect) => {
      if (label === "time-travel") {
        await adapter.internalStorage.execute(
          `UPDATE _smithers_rewind_leases
              SET owner_token = ?, expires_at_ms = ?
            WHERE run_id = ?`,
          ["stolen-owner", Date.now() + 60_000, "lease-steal-after-compensation"],
        );
      }
      return await originalWithTransaction(label, effect);
    };

    await expect(timeTravel(adapter, {
      runId: "lease-steal-after-compensation",
      nodeId: "target",
      iteration: 0,
      attempt: 1,
      restoreVcs: false,
    })).rejects.toThrow("lease ownership was lost");

    expect(globalThis.__smithersEffectBoundaryReverts.map((entry) => entry.kind))
      .toEqual(["tool"]);
    expect((await adapter.listFrames("lease-steal-after-compensation", 10)).map((frame) => frame.frameNo))
      .toEqual([1, 0]);
    expect(await adapter.getNode("lease-steal-after-compensation", "target", 0))
      .toMatchObject({ state: "finished" });
    expect(sqlite.query(
      `SELECT revert_status FROM _smithers_tool_calls WHERE run_id = ?`,
    ).all("lease-steal-after-compensation")).toEqual([{ revert_status: "reverted" }]);

    delete globalThis.__smithersEffectBoundaryReverts;
    sqlite.close();
  });

  test("public revert and timetravel refuse a live run unless forced", async () => {
    const { sqlite, adapter } = await setup("live-run");
    await adapter.updateRun("live-run", {
      status: "running",
      heartbeatAtMs: Date.now(),
      runtimeOwnerId: null,
    });
    await adapter.insertNode({
      runId: "live-run",
      nodeId: "task",
      iteration: 0,
      state: "finished",
      lastAttempt: 1,
      updatedAtMs: 100,
      outputTable: "",
      label: null,
    });
    await adapter.insertAttempt({
      runId: "live-run",
      nodeId: "task",
      iteration: 0,
      attempt: 1,
      state: "finished",
      startedAtMs: 100,
      finishedAtMs: 110,
      jjPointer: "must-not-be-used",
    });

    const reverted = await revertToAttempt(adapter, {
      runId: "live-run",
      nodeId: "task",
      iteration: 0,
      attempt: 1,
    });
    const travelled = await timeTravel(adapter, {
      runId: "live-run",
      nodeId: "task",
      iteration: 0,
      attempt: 1,
      restoreVcs: false,
    });

    expect(reverted).toMatchObject({
      success: false,
      error: expect.stringContaining("still running"),
    });
    expect(travelled).toMatchObject({
      success: false,
      error: expect.stringContaining("still running"),
    });
    sqlite.close();
  });
});
