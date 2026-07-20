/**
 * Guards the rewind post-commit branch (jumpToFrame.js, the `if (committed)` arm
 * of the catch). Once the durable jump transaction commits, a failure in the
 * resume hook / resume loop must NOT revert sandboxes, restore the reconciler,
 * or mark the run failed — the jump already happened. jumpToFrame instead
 * resumes best-effort, logs a warning, and returns the pre-built success result.
 *
 * The failure is injected via `hooks.beforeStep("resume-event-loop")`, which
 * throws after commit but before `input.resumeRunLoop()` runs, so the recovery
 * resume in the catch (no resumeRunLoop provided) is a clean no-op and only the
 * "post-commit step failed" warning fires.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { jumpToFrame } from "../src/jumpToFrame.js";
import { listRewindAuditRows } from "../src/rewindAudit.js";
import { resetRewindLocksForTests } from "../src/resetRewindLocksForTests.js";

function setupDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

async function seedRun(adapter: SmithersDb, runId: string) {
  await adapter.insertRun({
    runId,
    workflowName: "wf",
    status: "running",
    createdAtMs: 1,
    startedAtMs: 1,
    finishedAtMs: null,
  });
  await adapter.insertFrame({
    runId,
    frameNo: 0,
    createdAtMs: 100,
    xmlJson: JSON.stringify({ frame: 0 }),
    xmlHash: "h0",
  });
  await adapter.insertFrame({
    runId,
    frameNo: 1,
    createdAtMs: 200,
    xmlJson: JSON.stringify({ frame: 1 }),
    xmlHash: "h1",
  });
}

describe("jumpToFrame post-commit failure", () => {
  test("a resume-hook failure after commit keeps the jump and returns success", async () => {
    resetRewindLocksForTests();
    const { adapter, sqlite } = setupDb();
    try {
      const runId = "run-post-commit";
      await seedRun(adapter, runId);

      const logs: Array<{ level: string; message: string }> = [];
      let restoreCalled = false;

      const result = await jumpToFrame({
        adapter,
        runId,
        frameNo: 0,
        confirm: true,
        caller: "user:owner",
        captureReconcilerState: async () => ({ snapshot: "pre-jump" }),
        restoreReconcilerState: async () => {
          restoreCalled = true;
        },
        rebuildReconcilerState: async () => {},
        getCurrentPointerImpl: async () => "pre-pointer",
        revertToPointerImpl: async () => ({ success: true }),
        onLog: async (level: string, message: string) => {
          logs.push({ level, message });
        },
        hooks: {
          beforeStep: async (step) => {
            if (step === "resume-event-loop") {
              throw new Error("resume hook boom");
            }
          },
        },
      });

      // The jump is reported as a success at the target frame.
      expect(result.ok).toBe(true);
      expect(result.newFrameNo).toBe(0);
      expect(result.deletedFrames).toBe(1);

      // The durable jump committed and was NOT rolled back: frame 1 is gone and
      // the post-commit failure did not restore the reconciler snapshot.
      const frames = await adapter.listFrames(runId, 20);
      expect(frames.map((frame) => frame.frameNo)).toEqual([0]);
      expect(restoreCalled).toBe(false);

      // The audit row is a success, and the run is not marked failed.
      const audits = await listRewindAuditRows(adapter, { runId });
      expect(audits).toHaveLength(1);
      expect(audits[0]?.result).toBe("success");
      const run = await adapter.getRun(runId);
      expect(run?.status).not.toBe("failed");

      // The post-commit failure is logged as a warning; because no resumeRunLoop
      // was provided the best-effort recovery is a clean no-op (no second warn).
      const warnings = logs.filter((entry) => entry.level === "warn");
      expect(
        warnings.some((entry) => entry.message === "jumpToFrame post-commit step failed"),
      ).toBe(true);
      expect(
        warnings.some((entry) => entry.message === "jumpToFrame resume after commit failed"),
      ).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});
