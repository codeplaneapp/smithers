/**
 * Closes the remaining own-src coverage gaps that do not involve the jj VCS
 * seam: barrel exports, diff formatting, drizzle table config callbacks,
 * liveness probes, rewind-audit helper branches, DB-fault catch paths of the
 * snapshot/fork/vcs-tag Effects (real missing-table faults on a real
 * bun:sqlite backend), the postgres-dialect row-mapping arrows, and the
 * retry-task / timetravel error branches.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import * as timeTravelBarrel from "../src/index.js";
import * as rewindRateLimitBarrel from "../src/rewindRateLimit.js";
import { diffSnapshots, formatDiffForTui, formatDiffAsJson } from "../src/diff.js";
import { smithersSnapshots, smithersBranches, smithersVcsTags } from "../src/schema.js";
import { isRunLikelyLive, parseRuntimeOwnerPid } from "../src/isRunLikelyLive.js";
import { resolveRewindAuditClient } from "../src/resolveRewindAuditClient.js";
import { listRewindAuditRows } from "../src/listRewindAuditRows.js";
import { updateRewindAuditRow } from "../src/updateRewindAuditRow.js";
import { writeRewindAuditRow } from "../src/writeRewindAuditRow.js";
import { evaluateRewindRateLimit } from "../src/evaluateRewindRateLimit.js";
import { recoverInProgressRewindAudits } from "../src/recoverInProgressRewindAudits.js";
import { recoverRewindAuditsAtStartup } from "../src/recoverRewindAuditsAtStartup.js";
import { captureSnapshot, loadSnapshot, loadLatestSnapshot, listSnapshots } from "../src/snapshot/index.js";
import { forkRun, getBranchInfo, listBranches } from "../src/fork/index.js";
import { loadVcsTag } from "../src/vcs-version/index.js";
import { retryTask } from "../src/retry-task.js";
import { timeTravel } from "../src/timetravel.js";
import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { delimiter } from "node:path";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../smithers/tests/e2e-helpers.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), db, sqlite };
}

/** A real adapter over an empty database: every query is a real missing-table fault. */
function createNoTablesDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  return { adapter: new SmithersDb(db), db, sqlite };
}

/**
 * Same live database, but the storage layer reports the postgres dialect so
 * the `internalStorage.queryOne(...).then(...)` row-mapping arrows execute.
 * The raw SQL those branches issue uses `?` placeholders and the shared
 * `_smithers_*` table names, which the underlying sqlite storage executes
 * as-is, so the assertion is that both dialect paths return the same rows.
 */
function spoofPostgresDialect(adapter: SmithersDb): SmithersDb {
  const pgStorage = Object.create(adapter.internalStorage);
  Object.defineProperty(pgStorage, "dialect", { value: "postgres" });
  const pgAdapter = Object.create(adapter);
  Object.defineProperty(pgAdapter, "internalStorage", { value: pgStorage });
  return pgAdapter as SmithersDb;
}

function sampleSnapshotData(overrides: Record<string, unknown> = {}) {
  return {
    nodes: [{ nodeId: "analyze", iteration: 0, state: "finished", lastAttempt: 1, outputTable: "out_a", label: null }],
    outputs: { out_a: [{ text: "done" }] },
    ralph: [],
    input: { prompt: "hi" },
    ...overrides,
  };
}

describe("barrel exports", () => {
  test("src/index.js re-exports the public time-travel API", () => {
    expect(typeof timeTravelBarrel.revertToAttempt).toBe("function");
    expect(typeof timeTravelBarrel.timeTravel).toBe("function");
    expect(typeof timeTravelBarrel.captureSnapshot).toBe("function");
    expect(typeof timeTravelBarrel.diffSnapshots).toBe("function");
    expect(typeof timeTravelBarrel.forkRun).toBe("function");
    expect(typeof timeTravelBarrel.replayFromCheckpoint).toBe("function");
    expect(typeof timeTravelBarrel.tagSnapshotVcs).toBe("function");
    expect(typeof timeTravelBarrel.buildTimeline).toBe("function");
    expect(typeof timeTravelBarrel.jumpToFrame).toBe("function");
    expect(typeof timeTravelBarrel.acquireRewindLock).toBe("function");
    expect(typeof timeTravelBarrel.evaluateRewindRateLimit).toBe("function");
    expect(typeof timeTravelBarrel.writeRewindAuditRow).toBe("function");
    expect(timeTravelBarrel.smithersSnapshots).toBe(smithersSnapshots);
    expect(timeTravelBarrel.JUMP_MAX_FRAME_NO).toBeGreaterThan(0);
  });

  test("src/rewindRateLimit.js re-exports the quota API", () => {
    expect(typeof rewindRateLimitBarrel.evaluateRewindRateLimit).toBe("function");
    expect(rewindRateLimitBarrel.REWIND_RATE_LIMIT_MAX).toBeGreaterThan(0);
    expect(rewindRateLimitBarrel.REWIND_RATE_LIMIT_WINDOW_MS).toBeGreaterThan(0);
  });
});

describe("diff formatting", () => {
  test("formatDiffForTui renders every change section", () => {
    const a = {
      runId: "r",
      frameNo: 0,
      nodes: {
        "removed::0": {
          nodeId: "removed",
          iteration: 0,
          state: "finished",
          lastAttempt: 1,
          outputTable: "out_r",
          label: null,
        },
        "changed::0": {
          nodeId: "changed",
          iteration: 0,
          state: "pending",
          lastAttempt: null,
          outputTable: "out_c",
          label: null,
        },
      },
      outputs: { gone: [1], mutated: [1] },
      ralph: { changedLoop: { ralphId: "changedLoop", iteration: 0, done: false } },
      input: { prompt: "a" },
      vcsPointer: "ptr-a",
      workflowHash: null,
      contentHash: "h",
      createdAtMs: 1,
    };
    const b = {
      runId: "r",
      frameNo: 1,
      nodes: {
        "added::0": {
          nodeId: "added",
          iteration: 0,
          state: "pending",
          lastAttempt: null,
          outputTable: "out_n",
          label: null,
        },
        "changed::0": {
          nodeId: "changed",
          iteration: 0,
          state: "finished",
          lastAttempt: 2,
          outputTable: "out_c",
          label: null,
        },
      },
      outputs: { fresh: [2], mutated: [3] },
      ralph: { changedLoop: { ralphId: "changedLoop", iteration: 3, done: true } },
      input: { prompt: "b" },
      vcsPointer: "ptr-b",
      workflowHash: null,
      contentHash: "h2",
      createdAtMs: 2,
    };
    const diff = diffSnapshots(a as never, b as never);
    expect(diff.nodesAdded).toEqual(["added::0"]);
    expect(diff.nodesRemoved).toEqual(["removed::0"]);
    expect(diff.outputsAdded).toEqual(["fresh"]);
    expect(diff.outputsRemoved).toEqual(["gone"]);
    expect(diff.outputsChanged.map((o) => o.key)).toEqual(["mutated"]);
    expect(diff.ralphChanged.map((r) => r.ralphId)).toEqual(["changedLoop"]);
    expect(diff.inputChanged).toBe(true);
    expect(diff.vcsPointerChanged).toBe(true);

    const text = formatDiffForTui(diff);
    expect(text).toContain("Nodes added:");
    expect(text).toContain("added::0");
    expect(text).toContain("Nodes removed:");
    expect(text).toContain("removed::0");
    expect(text).toContain("Nodes changed:");
    expect(text).toContain("Outputs added:");
    expect(text).toContain("fresh");
    expect(text).toContain("Outputs removed:");
    expect(text).toContain("gone");
    expect(text).toContain("Outputs changed:");
    expect(text).toContain("mutated");
    expect(text).toContain("Ralph (loops) changed:");
    expect(text).toContain("iter 0->3 done false->true");
    expect(text).toContain("Input changed");
    expect(text).toContain("VCS pointer changed");

    expect(formatDiffAsJson(diff)).toEqual({ ...diff });
  });
});

describe("schema table config", () => {
  test("composite primary keys are declared on snapshots and vcs tags", () => {
    const snapshots = getTableConfig(smithersSnapshots);
    expect(snapshots.primaryKeys).toHaveLength(1);
    expect(snapshots.primaryKeys[0]?.columns.map((c) => c.name).sort()).toEqual(["frame_no", "run_id"]);

    const vcsTags = getTableConfig(smithersVcsTags);
    expect(vcsTags.primaryKeys).toHaveLength(1);
    expect(vcsTags.primaryKeys[0]?.columns.map((c) => c.name).sort()).toEqual(["frame_no", "run_id"]);

    const branches = getTableConfig(smithersBranches);
    expect(branches.columns.some((c) => c.name === "run_id" && c.primary)).toBe(true);
  });
});

describe("isRunLikelyLive", () => {
  test("parseRuntimeOwnerPid parses pid formats and rejects garbage", () => {
    expect(parseRuntimeOwnerPid(null)).toBeNull();
    expect(parseRuntimeOwnerPid("")).toBeNull();
    expect(parseRuntimeOwnerPid("   ")).toBeNull();
    expect(parseRuntimeOwnerPid("pid:1234")).toBe(1234);
    expect(parseRuntimeOwnerPid("PID:77:host-a")).toBe(77);
    expect(parseRuntimeOwnerPid("4321")).toBe(4321);
    expect(parseRuntimeOwnerPid("owner-abc")).toBeNull();
    expect(parseRuntimeOwnerPid("pid:0")).toBeNull();
    expect(parseRuntimeOwnerPid("0")).toBeNull();
  });

  test("a run owned by this live process is live regardless of heartbeat", () => {
    expect(isRunLikelyLive({ runtimeOwnerId: `pid:${process.pid}`, heartbeatAtMs: null })).toBe(true);
  });

  test("a dead owner pid falls back to the heartbeat window", () => {
    // A spawnSync child has exited and been reaped by the time it returns, so
    // its pid is a real dead-process probe (ESRCH).
    const dead = spawnSync("true", { stdio: "ignore" });
    expect(typeof dead.pid).toBe("number");
    const now = 1_000_000;
    expect(isRunLikelyLive({ runtimeOwnerId: `pid:${dead.pid}`, heartbeatAtMs: now - 60_000 }, now)).toBe(false);
    expect(isRunLikelyLive({ runtimeOwnerId: `pid:${dead.pid}`, heartbeatAtMs: now - 1_000 }, now)).toBe(true);
    expect(isRunLikelyLive({ runtimeOwnerId: null, heartbeatAtMs: null }, now)).toBe(false);
  });
});

describe("rewind audit helpers", () => {
  test("resolveRewindAuditClient throws without a usable storage layer", () => {
    expect(() => resolveRewindAuditClient(undefined as never)).toThrow(/internalStorage/);
    expect(() => resolveRewindAuditClient({} as never)).toThrow(/internalStorage/);
    expect(() => resolveRewindAuditClient({ internalStorage: {} } as never)).toThrow(/internalStorage/);
    const { adapter, sqlite } = createTestDb();
    try {
      expect(resolveRewindAuditClient(adapter)).toBe(adapter.internalStorage);
    } finally {
      sqlite.close();
    }
  });

  test("listRewindAuditRows without runId lists across runs with the default limit", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      // The audit table has a FK to _smithers_runs(run_id); seed both runs.
      await adapter.insertRun({ runId: "run-a", workflowName: "wf", status: "running", createdAtMs: 1 });
      await adapter.insertRun({ runId: "run-b", workflowName: "wf", status: "running", createdAtMs: 1 });
      await writeRewindAuditRow(adapter, {
        runId: "run-a",
        fromFrameNo: 4,
        toFrameNo: 1,
        caller: "user:a",
        timestampMs: 10,
        result: "success",
        durationMs: 5,
      });
      await writeRewindAuditRow(adapter, {
        runId: "run-b",
        fromFrameNo: 9,
        toFrameNo: 0,
        caller: "user:b",
        timestampMs: 20,
        result: "failed",
        durationMs: null,
      });
      const rows = await listRewindAuditRows(adapter);
      expect(rows.map((r) => r.runId)).toEqual(["run-a", "run-b"]);
      expect(rows[1]).toMatchObject({
        fromFrameNo: 9,
        toFrameNo: 0,
        caller: "user:b",
        result: "failed",
        durationMs: null,
      });
    } finally {
      sqlite.close();
    }
  });

  test("updateRewindAuditRow without fromFrameNo updates result and duration only", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      // The audit table has a FK to _smithers_runs(run_id); seed the run.
      await adapter.insertRun({ runId: "run-u", workflowName: "wf", status: "running", createdAtMs: 1 });
      const id = await writeRewindAuditRow(adapter, {
        runId: "run-u",
        fromFrameNo: 7,
        toFrameNo: 2,
        caller: "user:u",
        timestampMs: 10,
        result: "in_progress",
        durationMs: null,
      });
      expect(id).not.toBeNull();
      await updateRewindAuditRow(adapter, { id: id as number, result: "success", durationMs: 42 });
      const rows = await listRewindAuditRows(adapter, { runId: "run-u" });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id, fromFrameNo: 7, result: "success", durationMs: 42 });
    } finally {
      sqlite.close();
    }
  });

  test("evaluateRewindRateLimit uses wall-clock now and built-in quota by default", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      // The audit table has a FK to _smithers_runs(run_id); seed the run.
      await adapter.insertRun({ runId: "run-q", workflowName: "wf", status: "running", createdAtMs: 1 });
      await writeRewindAuditRow(adapter, {
        runId: "run-q",
        fromFrameNo: 3,
        toFrameNo: 1,
        caller: "user:q",
        timestampMs: Date.now(),
        result: "success",
        durationMs: 1,
      });
      const result = await evaluateRewindRateLimit({ adapter, runId: "run-q", caller: "user:q" });
      expect(result.max).toBe(rewindRateLimitBarrel.REWIND_RATE_LIMIT_MAX);
      expect(result.windowMs).toBe(rewindRateLimitBarrel.REWIND_RATE_LIMIT_WINDOW_MS);
      expect(result.used).toBe(1);
      expect(result.limited).toBe(false);
      expect(result.windowStartedAtMs).toBeLessThanOrEqual(Date.now() - result.windowMs + 1_000);
    } finally {
      sqlite.close();
    }
  });

  test("recoverInProgressRewindAudits defaults nowMs to wall clock", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      await adapter.insertRun({ runId: "run-r", workflowName: "wf", status: "running", createdAtMs: 1 });
      const id = await writeRewindAuditRow(adapter, {
        runId: "run-r",
        fromFrameNo: 5,
        toFrameNo: 2,
        caller: "user:r",
        timestampMs: Date.now() - 500,
        result: "in_progress",
        durationMs: null,
      });
      const { recovered } = await recoverInProgressRewindAudits(adapter, { staleAfterMs: 0 });
      expect(recovered).toEqual([{ id: id as number, runId: "run-r" }]);
      const rows = await listRewindAuditRows(adapter, { runId: "run-r" });
      expect(rows[0]?.result).toBe("partial");
      expect(rows[0]?.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      sqlite.close();
    }
  });

  test("recoverRewindAuditsAtStartup reports unexpected failures via onError and never throws", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      const failingStorage = Object.create(adapter.internalStorage);
      failingStorage.queryAll = () => {
        throw new Error("audit table scan exploded");
      };
      const failingAdapter = Object.create(adapter);
      Object.defineProperty(failingAdapter, "internalStorage", { value: failingStorage });

      const errors: unknown[] = [];
      let recoveredCount = -1;
      await recoverRewindAuditsAtStartup(failingAdapter, {
        onRecovered: (count) => {
          recoveredCount = count;
        },
        onError: (error) => {
          errors.push(error);
        },
      });
      expect(recoveredCount).toBe(-1);
      expect(errors).toHaveLength(1);
      expect(String(errors[0])).toContain("audit table scan exploded");
    } finally {
      sqlite.close();
    }
  });
});

describe("DB fault paths surface SmithersError (real missing-table faults)", () => {
  test("snapshot reads and writes reject with wrapped DB errors", async () => {
    const { adapter, sqlite } = createNoTablesDb();
    try {
      await expect(loadSnapshot(adapter, "run-x", 0)).rejects.toThrow(/no such table/i);
      await expect(loadLatestSnapshot(adapter, "run-x")).rejects.toThrow(/no such table/i);
      await expect(listSnapshots(adapter, "run-x")).rejects.toThrow(/no such table/i);
      await expect(captureSnapshot(adapter, "run-x", 0, sampleSnapshotData() as never)).rejects.toThrow(
        /no such table/i,
      );
    } finally {
      sqlite.close();
    }
  });

  test("branch reads reject with wrapped DB errors", async () => {
    const { adapter, sqlite } = createNoTablesDb();
    try {
      await expect(listBranches(adapter, "run-x")).rejects.toThrow(/no such table/i);
      await expect(getBranchInfo(adapter, "run-x")).rejects.toThrow(/no such table/i);
    } finally {
      sqlite.close();
    }
  });

  test("vcs tag reads reject with wrapped DB errors", async () => {
    const { adapter, sqlite } = createNoTablesDb();
    try {
      await expect(loadVcsTag(adapter, "run-x", 0)).rejects.toThrow(/no such table/i);
    } finally {
      sqlite.close();
    }
  });
});

describe("postgres dialect row mapping", () => {
  test("loadSnapshot / loadLatestSnapshot map found and missing rows", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      await captureSnapshot(adapter, "run-pg", 0, sampleSnapshotData() as never);
      await captureSnapshot(adapter, "run-pg", 3, sampleSnapshotData({ input: { prompt: "later" } }) as never);
      const pgAdapter = spoofPostgresDialect(adapter);

      const viaPg = await loadSnapshot(pgAdapter, "run-pg", 3);
      const viaSqlite = await loadSnapshot(adapter, "run-pg", 3);
      expect(viaPg).toEqual(viaSqlite);
      expect(viaPg?.frameNo).toBe(3);

      expect(await loadSnapshot(pgAdapter, "run-pg", 99)).toBeUndefined();

      const latestPg = await loadLatestSnapshot(pgAdapter, "run-pg");
      expect(latestPg).toEqual(await loadLatestSnapshot(adapter, "run-pg"));
      expect(latestPg?.frameNo).toBe(3);
      expect(await loadLatestSnapshot(pgAdapter, "run-none")).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  test("getBranchInfo maps found and missing rows", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      await captureSnapshot(adapter, "run-parent", 1, sampleSnapshotData() as never);
      const fork = await forkRun(adapter, { parentRunId: "run-parent", frameNo: 1, branchLabel: "pg-branch" });
      const pgAdapter = spoofPostgresDialect(adapter);

      const viaPg = await getBranchInfo(pgAdapter, fork.runId);
      expect(viaPg).toEqual(await getBranchInfo(adapter, fork.runId));
      expect(viaPg?.branchLabel).toBe("pg-branch");
      expect(await getBranchInfo(pgAdapter, "run-missing")).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  test("loadVcsTag maps found and missing rows", async () => {
    const { adapter, db, sqlite } = createTestDb();
    try {
      await db.insert(smithersVcsTags).values({
        runId: "run-tag",
        frameNo: 2,
        vcsType: "jj",
        vcsPointer: "commit-xyz",
        vcsRoot: "/repo",
        jjOperationId: "op-9",
        createdAtMs: 77,
      });
      const pgAdapter = spoofPostgresDialect(adapter);
      const viaPg = await loadVcsTag(pgAdapter, "run-tag", 2);
      expect(viaPg).toEqual(await loadVcsTag(adapter, "run-tag", 2));
      expect(viaPg?.vcsPointer).toBe("commit-xyz");
      expect(await loadVcsTag(pgAdapter, "run-tag", 3)).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });
});

describe("forkRun failure branches", () => {
  test("wraps a parent-run metadata read failure as DB_QUERY_FAILED", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      await captureSnapshot(adapter, "run-meta", 0, sampleSnapshotData() as never);
      const failingAdapter = Object.create(adapter);
      failingAdapter.getRun = () => Promise.reject(new Error("run row unavailable"));
      await expect(forkRun(failingAdapter, { parentRunId: "run-meta", frameNo: 0 })).rejects.toThrow(
        /load parent run metadata|run row unavailable/,
      );
    } finally {
      sqlite.close();
    }
  });

  test("a corrupt parent configJson is replaced when stamping durability metadata", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      await captureSnapshot(adapter, "run-cfg", 0, sampleSnapshotData() as never);
      await adapter.insertRun({ runId: "run-cfg", workflowName: "wf", status: "finished", createdAtMs: 1 });
      // Corrupt the stored config after the fact — a real torn-write artifact.
      const client = (adapter as never as { db: { session: { client: Database } } }).db.session.client;
      client.query(`UPDATE _smithers_runs SET config_json = ? WHERE run_id = ?`).run("{definitely-not-json", "run-cfg");

      const fork = await forkRun(adapter, {
        parentRunId: "run-cfg",
        frameNo: 0,
        entryWorkflowHash: "hash-entry-1",
      });
      const childRun = await adapter.getRun(fork.runId);
      const config = JSON.parse(childRun?.configJson ?? "{}");
      expect(config.__smithersDurability).toMatchObject({ entryWorkflowHash: "hash-entry-1" });
    } finally {
      sqlite.close();
    }
  });

  test("a corrupt nodesJson at the reset step surfaces as a wrapped parse error", async () => {
    // Snapshot/content hydration now materializes one joined row. Corrupt JSON
    // must still fail before the fork transaction starts and be wrapped as a
    // DB_QUERY_FAILED parse error rather than leaking a raw SyntaxError.
    const tornRow = {
      runId: "run-torn",
      frameNo: 1,
      nodesJson: "{corrupt",
      outputsJson: JSON.stringify({}),
      ralphJson: "[]",
      inputJson: JSON.stringify({ prompt: "x" }),
      vcsPointer: null,
      workflowHash: null,
      contentHash: "h",
      createdAtMs: 1,
    };
    const fakePgAdapter = {
      internalStorage: {
        dialect: "postgres",
        execute: async () => {},
        queryAll: async () => [],
        queryOne: async () => tornRow,
      },
      getRun: async () => null,
    };
    await expect(
      forkRun(fakePgAdapter as never, { parentRunId: "run-torn", frameNo: 1, resetNodes: ["analyze"] }),
    ).rejects.toThrow(/parse snapshot nodes|not valid JSON/);
  });

  test("a blocked child snapshot insert rolls the whole fork back", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      await captureSnapshot(adapter, "parent-block", 0, sampleSnapshotData() as never);
      await adapter.insertRun({ runId: "parent-block", workflowName: "wf", status: "finished", createdAtMs: 1 });
      // Real DB-level fault: a trigger vetoes the child's frame-0 snapshot row.
      sqlite.exec(`
        CREATE TRIGGER block_child_snapshot BEFORE INSERT ON _smithers_snapshots
        WHEN NEW.run_id <> 'parent-block'
        BEGIN
          SELECT RAISE(ABORT, 'child snapshot vetoed');
        END;
      `);
      await expect(forkRun(adapter, { parentRunId: "parent-block", frameNo: 0 })).rejects.toThrow(
        /insert forked snapshot|child snapshot vetoed/,
      );
      // The transaction rolled back: no branch row and no child run row survive.
      expect(await listBranches(adapter, "parent-block")).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});

describe("retryTask branches", () => {
  test("resets an explicitly named parked child from persisted ownership", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      await adapter.insertRun({
        runId: "parent-explicit",
        workflowName: "parent",
        status: "failed",
        createdAtMs: 1,
      });
      await adapter.insertNode({
        runId: "parent-explicit",
        nodeId: "review",
        iteration: 0,
        state: "failed",
        lastAttempt: 1,
        updatedAtMs: 10,
        outputTable: "",
        label: null,
      });
      await adapter.insertRun({
        runId: "named-review-run",
        parentRunId: "parent-explicit",
        workflowName: "child",
        status: "waiting-event",
        createdAtMs: 2,
        configJson: JSON.stringify({ subflowWorkspaceParentRunId: "parent-explicit" }),
      });
      await adapter.insertNode({
        runId: "named-review-run",
        nodeId: "wait",
        iteration: 0,
        state: "waiting-event",
        lastAttempt: 1,
        updatedAtMs: 20,
        outputTable: "",
        label: null,
      });
      await adapter.insertAttempt({
        runId: "named-review-run",
        nodeId: "wait",
        iteration: 0,
        attempt: 1,
        state: "waiting-event",
        startedAtMs: 20,
        finishedAtMs: null,
      });

      expect((await retryTask(adapter, { runId: "parent-explicit", nodeId: "review" })).success).toBe(true);
      expect((await adapter.getNode("named-review-run", "wait", 0))?.state).toBe("pending");
      expect((await adapter.getRun("named-review-run"))?.status).toBe("running");
      expect((await adapter.listAttempts("named-review-run", "wait", 0))[0]?.state).toBe("cancelled");
    } finally {
      sqlite.close();
    }
  });

  test("resets a continue-as-new child lineage through its parked successor", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      const parentRunId = "parent-continuation";
      const childRunId = `${parentRunId}:child:review:0`;
      const successorRunId = "named-continuation-successor";
      await adapter.insertRun({ runId: parentRunId, workflowName: "parent", status: "failed", createdAtMs: 1 });
      await adapter.insertNode({
        runId: parentRunId,
        nodeId: "review",
        iteration: 0,
        state: "failed",
        lastAttempt: 1,
        updatedAtMs: 10,
        outputTable: "",
        label: null,
      });
      await adapter.insertRun({
        runId: childRunId,
        parentRunId,
        workflowName: "child",
        status: "continued",
        createdAtMs: 2,
        configJson: JSON.stringify({ subflowWorkspaceParentRunId: parentRunId }),
      });
      await adapter.insertNode({
        runId: childRunId,
        nodeId: "segment-one",
        iteration: 0,
        state: "finished",
        lastAttempt: 1,
        updatedAtMs: 20,
        outputTable: "",
        label: null,
      });
      await adapter.insertRun({
        runId: successorRunId,
        parentRunId: childRunId,
        workflowName: "child",
        status: "waiting-timer",
        createdAtMs: 3,
        configJson: JSON.stringify({ continuation: { parentRunId: childRunId } }),
      });
      await adapter.insertNode({
        runId: successorRunId,
        nodeId: "segment-two",
        iteration: 0,
        state: "waiting-timer",
        lastAttempt: 1,
        updatedAtMs: 30,
        outputTable: "",
        label: null,
      });

      expect((await retryTask(adapter, { runId: parentRunId, nodeId: "review" })).success).toBe(true);
      expect((await adapter.getRun(successorRunId))?.status).toBe("running");
      expect((await adapter.getNode(successorRunId, "segment-two", 0))?.state).toBe("pending");
      expect((await adapter.getRun(childRunId))?.status).toBe("running");
      expect((await adapter.getNode(childRunId, "segment-one", 0))?.state).toBe("pending");
    } finally {
      sqlite.close();
    }
  });

  test("CLI rollback restores completed nested child runs after pre-ownership resume failure", () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    repo.write(
      "workflow.tsx",
      `/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Subflow } from "smithers-orchestrator";
import { z } from "zod";

const { smithers, Workflow, Task, outputs } = createSmithers({
  input: z.object({ token: z.string() }),
  result: z.object({ value: z.number() }),
});

const grandchild = smithers(
  () => (
    <Workflow name="retry-rollback-grandchild">
      <Task id="work" output={outputs.result}>{{ value: 1 }}</Task>
    </Workflow>
  ),
  { output: outputs.result },
);
const child = smithers(
  () => (
    <Workflow name="retry-rollback-child">
      <Subflow id="nested" mode="childRun" output={outputs.result} workflow={grandchild} />
    </Workflow>
  ),
  { output: outputs.result },
);
export default smithers(() => (
  <Workflow name="retry-rollback-parent">
    <Subflow id="review" mode="childRun" output={outputs.result} workflow={child} />
  </Workflow>
));
`,
    );
    const runId = "retry-cli-nested-pre-ownership-failure";
    const childRunId = `${runId}:child:review:0`;
    const grandchildRunId = `${childRunId}:child:nested:0`;
    const runIds = [runId, childRunId, grandchildRunId];
    const initial = runSmithers(
      ["up", "workflow.tsx", "--run-id", runId, "--input", JSON.stringify({ token: "seed" })],
      {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 90_000,
      },
    );
    expect(initial.exitCode, `${initial.stdout}\n${initial.stderr}`).toBe(0);

    const snapshot = (sqlite: Database, id: string) => ({
      run: sqlite.query("SELECT * FROM _smithers_runs WHERE run_id = ?").get(id),
      nodes: sqlite.query("SELECT * FROM _smithers_nodes WHERE run_id = ? ORDER BY node_id, iteration").all(id),
      attempts: sqlite
        .query("SELECT * FROM _smithers_attempts WHERE run_id = ? ORDER BY node_id, iteration, attempt")
        .all(id),
      outputs: sqlite.query("SELECT * FROM result WHERE run_id = ? ORDER BY node_id, iteration").all(id),
    });
    const sqlite = new Database(repo.path("smithers.db"));
    const before = Object.fromEntries(runIds.map((id) => [id, snapshot(sqlite, id)]));
    sqlite.query("DELETE FROM input WHERE run_id = ?").run(runId);
    sqlite.exec(
      "CREATE TRIGGER block_retry_input_restore BEFORE INSERT ON input BEGIN SELECT RAISE(ABORT, 'injected missing durable input'); END",
    );
    sqlite.close();

    const retried = runSmithers(["retry-task", "workflow.tsx", "--run-id", runId, "--node-id", "review"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: 90_000,
    });
    expect(retried.exitCode, `${retried.stdout}\n${retried.stderr}`).toBe(1);
    expect(retried.stderr).toContain("retry reset finished");

    const check = new Database(repo.path("smithers.db"), { readonly: true });
    try {
      const after = Object.fromEntries(runIds.map((id) => [id, snapshot(check, id)]));
      expect(after).toEqual(before);
    } finally {
      check.close();
    }
  }, 120_000);

  test("fails when the run row is missing", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      await adapter.insertNode({
        runId: "run-norun",
        nodeId: "task:a",
        iteration: 0,
        state: "failed",
        lastAttempt: 1,
        updatedAtMs: 5,
        outputTable: "",
        label: null,
      });
      const events: Array<{ type: string; error?: string }> = [];
      const result = await retryTask(adapter, {
        runId: "run-norun",
        nodeId: "task:a",
        onProgress: (event) => events.push(event as never),
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Run not found: run-norun");
      expect(events.at(-1)).toMatchObject({ type: "RetryTaskFinished", error: "Run not found: run-norun" });
    } finally {
      sqlite.close();
    }
  });

  test("resetDependents:false resets only the target node", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      await adapter.insertRun({ runId: "run-solo", workflowName: "wf", status: "failed", createdAtMs: 1 });
      await adapter.insertNode({
        runId: "run-solo",
        nodeId: "task:target",
        iteration: 0,
        state: "failed",
        lastAttempt: 1,
        updatedAtMs: 100,
        outputTable: "",
        label: null,
      });
      await adapter.insertNode({
        runId: "run-solo",
        nodeId: "task:downstream",
        iteration: 0,
        state: "finished",
        lastAttempt: 1,
        updatedAtMs: 200,
        outputTable: "",
        label: null,
      });

      const result = await retryTask(adapter, { runId: "run-solo", nodeId: "task:target", resetDependents: false });
      expect(result.success).toBe(true);
      expect(result.resetNodes).toEqual(["task:target"]);

      const downstream = await adapter.getNode("run-solo", "task:downstream", 0);
      expect(downstream?.state).toBe("finished");
    } finally {
      sqlite.close();
    }
  });

  test("resetDependents:false is preserved when cascading into a failed child run", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      const runId = "run-parent-solo";
      const childRunId = `${runId}:child:review:0`;
      await adapter.insertRun({ runId, workflowName: "parent", status: "failed", createdAtMs: 1 });
      await adapter.insertNode({
        runId,
        nodeId: "review",
        iteration: 0,
        state: "failed",
        lastAttempt: 1,
        updatedAtMs: 100,
        outputTable: "",
        label: null,
      });
      await adapter.insertRun({
        runId: childRunId,
        parentRunId: runId,
        workflowName: "child",
        status: "failed",
        createdAtMs: 2,
      });
      await adapter.insertNode({
        runId: childRunId,
        nodeId: "failed-child-task",
        iteration: 0,
        state: "failed",
        lastAttempt: 1,
        updatedAtMs: 100,
        outputTable: "",
        label: null,
      });
      await adapter.insertNode({
        runId: childRunId,
        nodeId: "later-finished-child-task",
        iteration: 0,
        state: "finished",
        lastAttempt: 1,
        updatedAtMs: 200,
        outputTable: "",
        label: null,
      });

      const result = await retryTask(adapter, { runId, nodeId: "review", resetDependents: false });
      expect(result.success).toBe(true);
      expect((await adapter.getNode(childRunId, "failed-child-task", 0))?.state).toBe("pending");
      expect((await adapter.getNode(childRunId, "later-finished-child-task", 0))?.state).toBe("finished");
    } finally {
      sqlite.close();
    }
  });

  test("dependents are ordered by attempt sequence and higher iterations are always reset", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      await adapter.insertRun({ runId: "run-order", workflowName: "wf", status: "failed", createdAtMs: 1 });
      // Target and a later dependent both HAVE attempt rows, so both appear in
      // attemptOrder — the dependent must be reset because its attempt sequence
      // is after the target's (exercises the attempt-order comparison branch).
      await adapter.insertNode({
        runId: "run-order",
        nodeId: "task:target",
        iteration: 0,
        state: "failed",
        lastAttempt: 1,
        updatedAtMs: 500,
        outputTable: "",
        label: null,
      });
      await adapter.insertNode({
        runId: "run-order",
        nodeId: "task:dep",
        iteration: 0,
        state: "finished",
        lastAttempt: 1,
        updatedAtMs: 10,
        outputTable: "",
        label: null,
      });
      // A node at a higher iteration is always downstream of the target.
      await adapter.insertNode({
        runId: "run-order",
        nodeId: "task:next-iter",
        iteration: 1,
        state: "finished",
        lastAttempt: 1,
        updatedAtMs: 5,
        outputTable: "",
        label: null,
      });
      // Insertion order defines attemptOrder: target (0) then dep (1).
      await adapter.insertAttempt({
        runId: "run-order",
        nodeId: "task:target",
        iteration: 0,
        attempt: 1,
        state: "failed",
        startedAtMs: 100,
        finishedAtMs: null,
      });
      await adapter.insertAttempt({
        runId: "run-order",
        nodeId: "task:dep",
        iteration: 0,
        attempt: 1,
        state: "failed",
        startedAtMs: 200,
        finishedAtMs: null,
      });

      const result = await retryTask(adapter, { runId: "run-order", nodeId: "task:target" });
      expect(result.success).toBe(true);
      // dep (later attempt order) and next-iter (higher iteration) are both reset
      // even though their updatedAtMs is earlier than the target's.
      expect(result.resetNodes.sort()).toEqual(["task:dep", "task:next-iter", "task:target"]);
    } finally {
      sqlite.close();
    }
  });

  test("nodes without attempts fall back to updatedAtMs ordering; terminal attempts are not cancelled", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      await adapter.insertRun({ runId: "run-retry", workflowName: "wf", status: "failed", createdAtMs: 1 });
      await adapter.insertNode({
        runId: "run-retry",
        nodeId: "task:target",
        iteration: 0,
        state: "failed",
        lastAttempt: 1,
        updatedAtMs: 100,
        outputTable: "",
        label: null,
      });
      // Dependent node that never got an attempt row — resolved via updatedAtMs.
      await adapter.insertNode({
        runId: "run-retry",
        nodeId: "task:later-no-attempt",
        iteration: 0,
        state: "pending",
        lastAttempt: null,
        updatedAtMs: 200,
        outputTable: "",
        label: null,
      });
      // Earlier node without attempts — must NOT be reset.
      await adapter.insertNode({
        runId: "run-retry",
        nodeId: "task:earlier",
        iteration: 0,
        state: "finished",
        lastAttempt: 1,
        updatedAtMs: 50,
        outputTable: "",
        label: null,
      });
      // Target has one failed attempt (finishedAtMs null → stamped at reset)
      // and one already-finished attempt that must be left untouched.
      await adapter.insertAttempt({
        runId: "run-retry",
        nodeId: "task:target",
        iteration: 0,
        attempt: 1,
        state: "finished",
        startedAtMs: 90,
        finishedAtMs: 95,
      });
      await adapter.insertAttempt({
        runId: "run-retry",
        nodeId: "task:target",
        iteration: 0,
        attempt: 2,
        state: "failed",
        startedAtMs: 96,
        finishedAtMs: null,
      });

      const result = await retryTask(adapter, { runId: "run-retry", nodeId: "task:target" });
      expect(result.success).toBe(true);
      expect(result.resetNodes.sort()).toEqual(["task:later-no-attempt", "task:target"]);

      const attempts = await adapter.listAttempts("run-retry", "task:target", 0);
      const finished = attempts.find((a: { attempt: number }) => a.attempt === 1);
      const failed = attempts.find((a: { attempt: number }) => a.attempt === 2);
      expect(finished?.state).toBe("finished");
      expect(failed?.state).toBe("cancelled");
      expect(failed?.finishedAtMs).not.toBeNull();

      const run = await adapter.getRun("run-retry");
      expect(run?.status).toBe("running");
    } finally {
      sqlite.close();
    }
  });

  test("cancels a waiting-quota attempt when retrying its parked task", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      const runId = "run-quota-parked";
      await adapter.insertRun({ runId, workflowName: "wf", status: "waiting-quota", createdAtMs: 1 });
      await adapter.insertNode({
        runId,
        nodeId: "task:quota",
        iteration: 0,
        state: "waiting-quota",
        lastAttempt: 1,
        updatedAtMs: 100,
        outputTable: "",
        label: null,
      });
      await adapter.insertAttempt({
        runId,
        nodeId: "task:quota",
        iteration: 0,
        attempt: 1,
        state: "waiting-quota",
        startedAtMs: 90,
        finishedAtMs: null,
      });

      const result = await retryTask(adapter, { runId, nodeId: "task:quota", force: true });

      expect(result.success).toBe(true);
      expect((await adapter.getNode(runId, "task:quota", 0))?.state).toBe("pending");
      const [attempt] = await adapter.listAttempts(runId, "task:quota", 0);
      expect(attempt?.state).toBe("cancelled");
      expect(attempt?.finishedAtMs).not.toBeNull();
      expect(JSON.parse(attempt?.metaJson ?? "{}")).toMatchObject({ resetCancelled: true });
    } finally {
      sqlite.close();
    }
  });
});

describe("scorer identity replay", () => {
  test("upserts a deterministic replay over a migrated v0.31 scorer row", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE _smithers_scorers (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        iteration INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0,
        scorer_id TEXT NOT NULL,
        scorer_name TEXT NOT NULL,
        source TEXT NOT NULL,
        score REAL NOT NULL,
        reason TEXT,
        meta_json TEXT,
        input_json TEXT,
        output_json TEXT,
        ground_truth_json TEXT,
        context_json TEXT,
        latency_ms REAL,
        scored_at_ms INTEGER NOT NULL,
        duration_ms REAL
      );
      INSERT INTO _smithers_scorers
        (id, run_id, node_id, iteration, attempt, scorer_id, scorer_name, source, score, scored_at_ms)
      VALUES
        ('5f65bd31-7d43-4e45-b30a-25f31216b0d0', 'run-legacy', 'review', 0, 1,
         'quality', 'Quality', 'live', 0.25, 1000);
    `);
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    try {
      await adapter.insertScorerResult({
        id: "scorer_deterministic",
        runId: "run-legacy",
        nodeId: "review",
        iteration: 0,
        attempt: 1,
        scorerId: "quality",
        scorerName: "Quality",
        source: "live",
        score: 0.9,
        scoredAtMs: 2000,
      });

      expect(await adapter.listScorerResults("run-legacy")).toEqual([
        expect.objectContaining({
          id: "scorer_deterministic",
          score: 0.9,
          scoredAtMs: 2000,
        }),
      ]);
    } finally {
      sqlite.close();
    }
  });
});

describe("oneshot resume preflight", () => {
  test("does not classify interrupted-run edits as pre-existing work on resume", () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    repo.write("tracked.txt", "before\n");
    repo.write(".gitignore", ".smithers/*\nsmithers.db*\n");
    repo.write("bin/codex", "#!/bin/sh\nexit 0\n");
    chmodSync(repo.path("bin/codex"), 0o755);
    repo.write(
      ".smithers/workflows/oneshot.tsx",
      `/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
const { Workflow, Task, smithers, outputs } = createSmithers({
  input: z.object({ goal: z.string(), review: z.enum(["on", "off"]), model: z.string() }),
  receipt: z.object({ ok: z.boolean() }),
});
export default smithers(() => (
  <Workflow name="custom-oneshot">
    <Task id="done" output={outputs.receipt}>{{ ok: true }}</Task>
  </Workflow>
));
`,
    );
    for (const args of [
      ["init", "-b", "main"],
      ["config", "user.name", "Smithers Test"],
      ["config", "user.email", "smithers@example.test"],
      ["config", "commit.gpgsign", "false"],
      ["add", "."],
      ["commit", "-m", "initial"],
    ]) {
      const result = spawnSync("git", args, { cwd: repo.dir, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
    repo.write("tracked.txt", "interrupted run work\n");
    const result = runSmithers(
      [
        "oneshot",
        "continue interrupted work",
        "--run-id",
        "oneshot-resume-preflight",
        "--resume",
        "true",
        "--force",
        "true",
        "--detach",
        "false",
        "--open",
        "false",
        "--review",
        "off",
        "--preflight",
        "auto",
      ],
      {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 60_000,
        env: {
          ...process.env,
          PATH: `${repo.path("bin")}${delimiter}${process.env.PATH ?? ""}`,
          SMITHERS_NO_SKILL_REFRESH: "1",
          OPENAI_API_KEY: "sk-oneshot-resume-preflight-fixture",
        },
      },
    );

    expect(`${result.stdout}\n${result.stderr}`).not.toContain("oneshot preflight: working copy");
  }, 90_000);
});

describe("timeTravel branches", () => {
  test("time travel resets an explicitly named continued child through its parked successor", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      const runId = "time-travel-explicit-child";
      const childRunId = "time-travel-named-child";
      const successorRunId = "time-travel-child-successor";
      await adapter.insertRun({ runId, workflowName: "parent", status: "failed", createdAtMs: 1 });
      await adapter.insertNode({
        runId,
        nodeId: "review",
        iteration: 0,
        state: "failed",
        lastAttempt: 1,
        updatedAtMs: 10,
        outputTable: "",
        label: null,
      });
      await adapter.insertAttempt({
        runId,
        nodeId: "review",
        iteration: 0,
        attempt: 1,
        state: "failed",
        startedAtMs: 10,
        finishedAtMs: 20,
        jjPointer: null,
      });
      await adapter.insertRun({
        runId: childRunId,
        parentRunId: runId,
        workflowName: "child",
        status: "continued",
        createdAtMs: 2,
        configJson: JSON.stringify({ subflowWorkspaceParentRunId: runId }),
      });
      await adapter.insertNode({
        runId: childRunId,
        nodeId: "segment-one",
        iteration: 0,
        state: "finished",
        lastAttempt: 1,
        updatedAtMs: 20,
        outputTable: "",
        label: null,
      });
      await adapter.insertRun({
        runId: successorRunId,
        parentRunId: childRunId,
        workflowName: "child",
        status: "waiting-approval",
        createdAtMs: 3,
        configJson: JSON.stringify({ continuation: { parentRunId: childRunId } }),
      });
      await adapter.insertNode({
        runId: successorRunId,
        nodeId: "gate",
        iteration: 0,
        state: "waiting-approval",
        lastAttempt: 1,
        updatedAtMs: 30,
        outputTable: "",
        label: null,
      });

      const result = await timeTravel(adapter, {
        runId,
        nodeId: "review",
        restoreVcs: false,
        resetDependents: false,
      });

      expect(result.success).toBe(true);
      expect((await adapter.getRun(childRunId))?.status).toBe("running");
      expect((await adapter.getNode(childRunId, "segment-one", 0))?.state).toBe("pending");
      expect((await adapter.getRun(successorRunId))?.status).toBe("running");
      expect((await adapter.getNode(successorRunId, "gate", 0))?.state).toBe("pending");
    } finally {
      sqlite.close();
    }
  });

  test("fails when the attempt exists but the node row is missing", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      await adapter.insertRun({ runId: "run-tt", workflowName: "wf", status: "failed", createdAtMs: 1 });
      await adapter.insertAttempt({
        runId: "run-tt",
        nodeId: "task:ghost",
        iteration: 0,
        attempt: 1,
        state: "failed",
        startedAtMs: 10,
        finishedAtMs: 20,
        jjPointer: null,
      });
      const result = await timeTravel(adapter, { runId: "run-tt", nodeId: "task:ghost", iteration: 0 });
      expect(result.success).toBe(false);
      expect(result.vcsRestored).toBe(false);
      expect(result.error).toContain("Node not found: run-tt/task:ghost/0");
    } finally {
      sqlite.close();
    }
  });

  test("cancelling an unfinished attempt stamps finishedAtMs", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      await adapter.insertRun({ runId: "run-tt2", workflowName: "wf", status: "failed", createdAtMs: 1 });
      await adapter.insertNode({
        runId: "run-tt2",
        nodeId: "task:t",
        iteration: 0,
        state: "failed",
        lastAttempt: 1,
        updatedAtMs: 10,
        outputTable: "",
        label: null,
      });
      // Target attempt: no jjPointer, so no VCS interaction.
      await adapter.insertAttempt({
        runId: "run-tt2",
        nodeId: "task:t",
        iteration: 0,
        attempt: 1,
        state: "in-progress",
        startedAtMs: 10,
        finishedAtMs: null,
        jjPointer: null,
      });
      const result = await timeTravel(adapter, { runId: "run-tt2", nodeId: "task:t", iteration: 0 });
      expect(result.success).toBe(true);
      expect(result.vcsRestored).toBe(false);
      const attempts = await adapter.listAttempts("run-tt2", "task:t", 0);
      expect(attempts[0]?.state).toBe("cancelled");
      expect(attempts[0]?.finishedAtMs).not.toBeNull();
    } finally {
      sqlite.close();
    }
  });
});
