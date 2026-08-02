import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

/**
 * @param {ReturnType<typeof createTempRepo>} repo
 */
function openRepoDb(repo) {
  pinSqliteBackend(repo.dir);
  const sqlite = new Database(repo.path("smithers.db"));
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return {
    sqlite,
    adapter: new SmithersDb(db),
  };
}

async function insertApprovalRun(adapter, runId, status = "waiting-approval", overrides = {}) {
  const now = Date.now();
  await adapter.insertRun({
    runId,
    workflowName: "approval-command",
    workflowPath: "workflow.tsx",
    status,
    createdAtMs: now - 10_000,
    startedAtMs: now - 9_000,
    finishedAtMs: status === "cancelled" ? now - 1_000 : null,
    heartbeatAtMs: status === "running" ? now : null,
    ...overrides,
  });
  await adapter.insertNode({
    runId,
    nodeId: "gate",
    iteration: 0,
    state: "waiting-approval",
    lastAttempt: 1,
    updatedAtMs: now - 5_000,
    outputTable: "approval_output",
    label: "Approval gate",
  });
}

async function insertApprovalRow(adapter, runId, overrides = {}) {
  const now = Date.now();
  await adapter.insertOrUpdateApproval({
    runId,
    nodeId: "gate",
    iteration: 0,
    status: "requested",
    requestedAtMs: now - 6_000,
    decidedAtMs: null,
    note: null,
    decidedBy: null,
    requestJson: null,
    decisionJson: null,
    autoApproved: false,
    ...overrides,
  });
}

describe("smithers approval commands", () => {
  test("approve resolves a waiting approval node when the request row is missing", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      await insertApprovalRun(adapter, "missing-row-approve");

      const result = runSmithers(["approve", "missing-row-approve", "--node", "gate", "--by", "tester"], {
        cwd: repo.dir,
        format: "json",
      });

      expect(result.exitCode).toBe(0);
      const approval = await adapter.getApproval("missing-row-approve", "gate", 0);
      const node = await adapter.getNode("missing-row-approve", "gate", 0);
      const run = await adapter.getRun("missing-row-approve");
      expect(approval).toMatchObject({
        status: "approved",
        decidedBy: "tester",
        requestedAtMs: null,
      });
      expect(node?.state).toBe("pending");
      expect(run?.status).toBe("waiting-event");
    } finally {
      sqlite.close();
    }
  });

  test("approve resolves a descendant gate when invoked with the parent run id", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      const now = Date.now();
      await adapter.insertRun({
        runId: "approval-parent",
        workflowName: "approval-command",
        workflowPath: "workflow.tsx",
        status: "waiting-approval",
        createdAtMs: now - 10_000,
        startedAtMs: now - 9_000,
      });
      await insertApprovalRun(adapter, "approval-child", "waiting-approval", {
        parentRunId: "approval-parent",
      });
      await insertApprovalRow(adapter, "approval-child");

      const result = runSmithers(["approve", "approval-parent", "--by", "tester"], {
        cwd: repo.dir,
        format: "json",
      });

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(await adapter.getApproval("approval-parent", "gate", 0)).toBeUndefined();
      expect(await adapter.getApproval("approval-child", "gate", 0)).toMatchObject({
        status: "approved",
        decidedBy: "tester",
      });
      expect((await adapter.getNode("approval-child", "gate", 0))?.state).toBe("pending");
    } finally {
      sqlite.close();
    }
  });

  test("deny resolves a waiting approval node when the request row is missing", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      await insertApprovalRun(adapter, "missing-row-deny");

      const result = runSmithers(["deny", "missing-row-deny", "--node", "gate", "--by", "tester"], {
        cwd: repo.dir,
        format: "json",
      });

      expect(result.exitCode).toBe(0);
      const approval = await adapter.getApproval("missing-row-deny", "gate", 0);
      const node = await adapter.getNode("missing-row-deny", "gate", 0);
      const run = await adapter.getRun("missing-row-deny");
      expect(approval).toMatchObject({
        status: "denied",
        decidedBy: "tester",
        requestedAtMs: null,
      });
      expect(node?.state).toBe("failed");
      expect(run?.status).toBe("waiting-event");
    } finally {
      sqlite.close();
    }
  });

  test("approve rejects terminal runs even when a stale waiting node remains", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      await insertApprovalRun(adapter, "cancelled-approval", "cancelled");

      const result = runSmithers(["approve", "cancelled-approval", "--node", "gate"], {
        cwd: repo.dir,
        format: "json",
      });

      expect(result.exitCode).toBe(4);
      expect(`${result.stdout}\n${result.stderr}`).toContain("RUN_NOT_ACTIVE");
      expect(await adapter.getApproval("cancelled-approval", "gate", 0)).toBeUndefined();
      expect((await adapter.getNode("cancelled-approval", "gate", 0))?.state).toBe("waiting-approval");
    } finally {
      sqlite.close();
    }
  });

  test("approve recovers a still-requested gate on a failed run before resume", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      await insertApprovalRun(adapter, "failed-approve", "failed");
      await insertApprovalRow(adapter, "failed-approve");

      const result = runSmithers(["approve", "failed-approve", "--by", "tester"], {
        cwd: repo.dir,
        format: "json",
      });

      expect(result.exitCode).toBe(0);
      expect((await adapter.getApproval("failed-approve", "gate", 0))?.status).toBe("approved");
      expect((await adapter.getNode("failed-approve", "gate", 0))?.state).toBe("pending");
      // approveNode does not resurrect a failed run; it stays failed until `up --resume`.
      expect((await adapter.getRun("failed-approve"))?.status).toBe("failed");
    } finally {
      sqlite.close();
    }
  });

  test("approve refuses a gate whose approval is already decided (human request pending)", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      await insertApprovalRun(adapter, "decided-approve");
      await insertApprovalRow(adapter, "decided-approve", {
        status: "approved",
        requestedAtMs: null,
        decidedAtMs: Date.now() - 4_000,
        decidedBy: "someone",
      });

      const result = runSmithers(["approve", "decided-approve", "--node", "gate"], {
        cwd: repo.dir,
        format: "json",
      });

      expect(result.exitCode).toBe(4);
      expect(`${result.stdout}\n${result.stderr}`).toContain("APPROVAL_ALREADY_DECIDED");
      // The already-decided approval and the waiting node are left untouched.
      expect((await adapter.getApproval("decided-approve", "gate", 0))?.status).toBe("approved");
      expect((await adapter.getNode("decided-approve", "gate", 0))?.state).toBe("waiting-approval");
    } finally {
      sqlite.close();
    }
  });
});
