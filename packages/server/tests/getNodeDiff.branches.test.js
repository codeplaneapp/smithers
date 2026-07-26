import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { getNodeDiffRoute, summarizeBundle } from "../src/gatewayRoutes/getNodeDiff.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

function runRow(runId, extra = {}) {
  return { runId, workflowName: "diff-branches", status: "finished", createdAtMs: Date.now(), ...extra };
}
function nodeRow(runId, nodeId, iteration = 0, extra = {}) {
  return {
    runId,
    nodeId,
    iteration,
    state: "finished",
    lastAttempt: 1,
    updatedAtMs: Date.now(),
    outputTable: "out",
    label: null,
    ...extra,
  };
}
function attemptRow(runId, nodeId, iteration, attempt, extra = {}) {
  return {
    runId,
    nodeId,
    iteration,
    attempt,
    state: "finished",
    startedAtMs: Date.now() - 1000,
    finishedAtMs: Date.now() - 500,
    heartbeatAtMs: null,
    heartbeatDataJson: null,
    errorJson: null,
    jjPointer: `ptr-${nodeId}-${attempt}`,
    responseText: null,
    jjCwd: "/tmp/diff-branches",
    cached: false,
    metaJson: null,
    ...extra,
  };
}

describe("getNodeDiffRoute summarizeBundle + stat path", () => {
  test("summarizeBundle counts +/- content lines and skips +++/--- headers", () => {
    const summary = summarizeBundle({
      patches: [
        { path: "a.txt", diff: "+++ b/a.txt\n--- a/a.txt\n@@ h @@\n+added one\n+added two\n-removed one\n context\n" },
        { path: "b.txt", diff: "" },
        { diff: undefined },
      ],
    });
    expect(summary.filesChanged).toBe(3);
    expect(summary.added).toBe(2);
    expect(summary.removed).toBe(1);
    expect(summary.files[0]).toEqual({ path: "a.txt", added: 2, removed: 1 });
    expect(summary.files[2].path).toBe("");
  });

  test("summarizeBundle tolerates a non-array patches field", () => {
    const summary = summarizeBundle({});
    expect(summary).toEqual({ filesChanged: 0, added: 0, removed: 0, files: [] });
  });

  test("stat:true returns a summary via the between-refs compute impl", async () => {
    const { sqlite, adapter } = createTestDb();
    const runId = "run-diff-stat";
    const nodeId = "task:stat";
    await adapter.insertRun(runRow(runId, { vcsRevision: "base-stat" }));
    await adapter.insertNode(nodeRow(runId, nodeId));
    await adapter.insertAttempt(attemptRow(runId, nodeId, 0, 1));
    const result = await getNodeDiffRoute({
      runId,
      nodeId,
      iteration: 0,
      stat: true,
      resolveRun: async () => ({ adapter }),
      computeDiffBundleBetweenRefsImpl: async (baseRef, targetRef, cwd, seq) => ({
        seq: seq ?? 1,
        baseRef,
        patches: [{ path: "s.txt", operation: "modify", diff: "@@ h @@\n+x\n-y\n" }],
      }),
      resolveCommitPointerImpl: async (pointer) => `resolved-${pointer}`,
      emitEffect: async () => undefined,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.summary.filesChanged).toBe(1);
      expect(result.payload.summary.added).toBe(1);
      expect(result.payload.summary.removed).toBe(1);
      expect(result.payload.baseRef).toBe("resolved-base-stat");
    }
    sqlite.close();
  });
});

describe("getNodeDiffRoute resolveBaseRef sort comparators", () => {
  test("previous-same-task selection sorts by finishedAtMs with attempt tie-break", async () => {
    const { sqlite, adapter } = createTestDb();
    const runId = "run-same-task-sort";
    const nodeId = "task:retry";
    await adapter.insertRun(runRow(runId, { vcsRevision: "base" }));
    await adapter.insertNode(nodeRow(runId, nodeId, 0, { lastAttempt: 4 }));
    await adapter.insertAttempt(attemptRow(runId, nodeId, 0, 1, { startedAtMs: 100, finishedAtMs: 1000 }));
    await adapter.insertAttempt(attemptRow(runId, nodeId, 0, 2, { startedAtMs: 200, finishedAtMs: 2000 }));
    await adapter.insertAttempt(attemptRow(runId, nodeId, 0, 3, { startedAtMs: 300, finishedAtMs: 2000 }));
    await adapter.insertAttempt(attemptRow(runId, nodeId, 0, 4, { startedAtMs: 400, finishedAtMs: 3000 }));
    let seenBaseRef = null;
    const result = await getNodeDiffRoute({
      runId,
      nodeId,
      iteration: 0,
      resolveRun: async () => ({ adapter }),
      computeDiffBundleImpl: async (baseRef, _cwd, seq) => {
        seenBaseRef = baseRef;
        return { seq: seq ?? 1, baseRef, patches: [] };
      },
      resolveCommitPointerImpl: async (pointer) => pointer,
      emitEffect: async () => undefined,
    });
    expect(result.ok).toBe(true);
    // Highest finishedAtMs among attempts < 4 is 2000 (attempts 2 and 3); the
    // tie-break picks the higher attempt number (3).
    expect(seenBaseRef).toBe("ptr-task:retry-3");
    sqlite.close();
  });

  test("previous-any-task fallback sorts by finishedAtMs with attempt tie-break", async () => {
    const { sqlite, adapter } = createTestDb();
    const runId = "run-any-task-sort";
    const cwd = "/tmp/any-task-sort";
    await adapter.insertRun(runRow(runId, { vcsRevision: "base" }));
    await adapter.insertNode(nodeRow(runId, "task:A", 0, { lastAttempt: 2 }));
    await adapter.insertNode(nodeRow(runId, "task:C", 0, { lastAttempt: 1 }));
    await adapter.insertNode(nodeRow(runId, "task:B", 0, { lastAttempt: 1 }));
    await adapter.insertAttempt(
      attemptRow(runId, "task:A", 0, 1, { startedAtMs: 100, finishedAtMs: 1000, jjCwd: cwd }),
    );
    await adapter.insertAttempt(
      attemptRow(runId, "task:A", 0, 2, { startedAtMs: 200, finishedAtMs: 3000, jjCwd: cwd }),
    );
    await adapter.insertAttempt(
      attemptRow(runId, "task:C", 0, 1, { startedAtMs: 300, finishedAtMs: 3000, jjCwd: cwd }),
    );
    // Target: first attempt of task B, started after all others finished.
    await adapter.insertAttempt(
      attemptRow(runId, "task:B", 0, 1, { startedAtMs: 9000, finishedAtMs: 9500, jjCwd: cwd }),
    );
    let seenBaseRef = null;
    const result = await getNodeDiffRoute({
      runId,
      nodeId: "task:B",
      iteration: 0,
      resolveRun: async () => ({ adapter }),
      computeDiffBundleImpl: async (baseRef, _cwd, seq) => {
        seenBaseRef = baseRef;
        return { seq: seq ?? 1, baseRef, patches: [] };
      },
      resolveCommitPointerImpl: async (pointer) => pointer,
      emitEffect: async () => undefined,
    });
    expect(result.ok).toBe(true);
    // Highest finishedAtMs before B started is 3000 (task:A#2 and task:C#1);
    // tie-break by attempt number picks task:A attempt 2.
    expect(seenBaseRef).toBe("ptr-task:A-2");
    sqlite.close();
  });
});

describe("getNodeDiffRoute cache logger + span error paths", () => {
  test("corrupt cached diff JSON logs a warning and recomputes as a miss", async () => {
    const { sqlite, adapter } = createTestDb();
    const runId = "run-corrupt-cache";
    const nodeId = "task:corrupt";
    await adapter.insertRun(runRow(runId, { vcsRevision: "base-corrupt" }));
    await adapter.insertNode(nodeRow(runId, nodeId));
    await adapter.insertAttempt(attemptRow(runId, nodeId, 0, 1));
    // Seed a cache row whose diffJson is not parseable so cache.get logs the
    // "Failed to parse cached node diff JSON" warning and treats it as a miss.
    await adapter.upsertNodeDiffCache({
      runId,
      nodeId,
      iteration: 0,
      baseRef: "base-corrupt",
      diffJson: "{ not: valid json",
      computedAtMs: Date.now(),
      sizeBytes: 17,
    });
    const warnings = [];
    let computeCalls = 0;
    const result = await getNodeDiffRoute({
      runId,
      nodeId,
      iteration: 0,
      resolveRun: async () => ({ adapter }),
      computeDiffBundleImpl: async (baseRef, _cwd, seq) => {
        computeCalls += 1;
        return { seq: seq ?? 1, baseRef, patches: [{ path: "z", operation: "modify", diff: "x" }] };
      },
      resolveCommitPointerImpl: async (pointer) => pointer,
      emitEffect: async (effect) => {
        warnings.push(effect);
        return undefined;
      },
    });
    expect(result.ok).toBe(true);
    expect(computeCalls).toBe(1);
    sqlite.close();
  });

  test("a cache.get that rejects is caught by the span wrapper and surfaced as VcsError", async () => {
    const target = {
      runId: "run-explode",
      nodeId: "task:explode",
      iteration: 0,
      attempt: 1,
      state: "finished",
      startedAtMs: 100,
      finishedAtMs: 500,
      jjPointer: "ptr-explode",
      jjCwd: "/tmp/explode",
    };
    const fakeAdapter = {
      async getNode() {
        return { runId: target.runId, nodeId: target.nodeId, iteration: 0, state: "finished" };
      },
      async listAttempts() {
        return [target];
      },
      async getRun() {
        return { vcsType: "jj", vcsRevision: "base" };
      },
      async listAttemptsForRun() {
        return [target];
      },
      async getNodeDiffCache() {
        throw new Error("db read exploded");
      },
      async countNodeDiffCacheRows() {
        return 0;
      },
    };
    const result = await getNodeDiffRoute({
      runId: "run-explode",
      nodeId: "task:explode",
      iteration: 0,
      resolveRun: async () => ({ adapter: fakeAdapter }),
      computeDiffBundleImpl: async (baseRef, _cwd, seq) => ({ seq: seq ?? 1, baseRef, patches: [] }),
      resolveCommitPointerImpl: async (pointer) => pointer,
      emitEffect: async () => undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VcsError");
      expect(result.error.message).toContain("exploded");
    }
  });
});
