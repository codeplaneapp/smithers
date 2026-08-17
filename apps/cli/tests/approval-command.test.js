import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { delimiter } from "node:path";
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

function installResumeStub(repo) {
  const spawnRecord = repo.path("builtin-resume-argv.txt");
  const windows = process.platform === "win32";
  const stub = repo.write(
    windows ? "bin/bun.cmd" : "bin/bun",
    windows
      ? '@echo off\r\necho %* > "%SMITHERS_TEST_SPAWN_RECORD%"\r\n'
      : '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$SMITHERS_TEST_SPAWN_RECORD"\n',
  );
  if (!windows) chmodSync(stub, 0o755);
  return { spawnRecord, binDir: repo.path("bin") };
}

async function waitForSpawnRecord(spawnRecord) {
  let contents = "";
  for (let attempt = 0; attempt < 500; attempt++) {
    if (existsSync(spawnRecord)) {
      contents = readFileSync(spawnRecord, "utf8");
      if (contents.includes("--resume")) return contents;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(existsSync(spawnRecord)).toBe(true);
  return contents;
}

function builtinResumeConfig(repo, goal) {
  return JSON.stringify({
    builtinResume: { command: "oneshot", args: [goal, "--agent", "codex"], cwd: repo.dir },
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

  test("approve resumes the detached descendant gate resolved from a parent run id", async () => {
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
      repo.write("workflow.tsx", "export default {};\n");
      const spawnRecord = repo.path("resume-argv.txt");
      const stub = repo.write("bin/bun", '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$SMITHERS_TEST_SPAWN_RECORD"\n');
      chmodSync(stub, 0o755);

      const result = runSmithers(["approve", "approval-parent", "--by", "tester"], {
        cwd: repo.dir,
        format: "json",
        env: {
          PATH: `${repo.path("bin")}${delimiter}${process.env.PATH ?? ""}`,
          SMITHERS_TEST_SPAWN_RECORD: spawnRecord,
        },
      });

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.json).toMatchObject({ runId: "approval-child", status: "approved", resumed: true });
      expect(await adapter.getApproval("approval-parent", "gate", 0)).toBeUndefined();
      expect(await adapter.getApproval("approval-child", "gate", 0)).toMatchObject({
        status: "approved",
        decidedBy: "tester",
      });
      expect((await adapter.getNode("approval-child", "gate", 0))?.state).toBe("pending");
      for (let attempt = 0; attempt < 500 && !existsSync(spawnRecord); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(spawnRecord)).toBe(true);
      const resumeArgv = readFileSync(spawnRecord, "utf8").trimEnd().split("\n");
      expect(resumeArgv).toContain("approval-child");
      expect(resumeArgv).not.toContain("approval-parent");
    } finally {
      sqlite.close();
    }
  });

  test("approve resumes a detached built-in oneshot", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      await insertApprovalRun(adapter, "builtin-approve", "waiting-approval", {
        workflowPath: null,
        configJson: builtinResumeConfig(repo, "approve built-in"),
      });
      await insertApprovalRow(adapter, "builtin-approve");
      const { spawnRecord, binDir } = installResumeStub(repo);

      const result = runSmithers(["approve", "builtin-approve", "--by", "tester"], {
        cwd: repo.dir,
        format: "json",
        env: {
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          SMITHERS_TEST_SPAWN_RECORD: spawnRecord,
        },
      });

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.json).toMatchObject({ runId: "builtin-approve", status: "approved", resumed: true });
      const argv = await waitForSpawnRecord(spawnRecord);
      expect(argv).toContain("oneshot");
      expect(argv).toContain("approve built-in");
      expect(argv).toContain("--resume");
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

  test("deny resumes a detached built-in oneshot", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      await insertApprovalRun(adapter, "builtin-deny", "waiting-approval", {
        workflowPath: null,
        configJson: builtinResumeConfig(repo, "deny built-in"),
      });
      await insertApprovalRow(adapter, "builtin-deny");
      const { spawnRecord, binDir } = installResumeStub(repo);

      const result = runSmithers(["deny", "builtin-deny", "--by", "tester"], {
        cwd: repo.dir,
        format: "json",
        env: {
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          SMITHERS_TEST_SPAWN_RECORD: spawnRecord,
        },
      });

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.json).toMatchObject({ runId: "builtin-deny", status: "denied", resumed: true });
      const argv = await waitForSpawnRecord(spawnRecord);
      expect(argv).toContain("oneshot");
      expect(argv).toContain("deny built-in");
      expect(argv).toContain("--resume");
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

  // --- auto-resume opt-out (--no-resume) -----------------------------------
  // A real workflow file is present so the DEFAULT path WOULD relaunch the
  // engine (see approve-auto-resume-unit.test.js). With --no-resume the
  // command only records the decision: no `resumed` key, run stays parked.
  test("approve --no-resume records the decision without relaunching the engine", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      repo.write("workflow.tsx", "export default {};\n");
      await insertApprovalRun(adapter, "no-resume-approve");
      await insertApprovalRow(adapter, "no-resume-approve");

      const result = runSmithers(["approve", "no-resume-approve", "--by", "tester", "--no-resume"], {
        cwd: repo.dir,
        format: "json",
      });

      expect(result.exitCode).toBe(0);
      expect(result.json?.status).toBe("approved");
      // --no-resume opted out: the auto-resume never fired.
      expect(result.json?.resumed).toBeUndefined();
      expect((await adapter.getApproval("no-resume-approve", "gate", 0))?.status).toBe("approved");
    } finally {
      sqlite.close();
    }
  });

  test("deny --no-resume records the decision without relaunching the engine", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      repo.write("workflow.tsx", "export default {};\n");
      await insertApprovalRun(adapter, "no-resume-deny");
      await insertApprovalRow(adapter, "no-resume-deny");

      const result = runSmithers(["deny", "no-resume-deny", "--by", "tester", "--no-resume"], {
        cwd: repo.dir,
        format: "json",
      });

      expect(result.exitCode).toBe(0);
      expect(result.json?.status).toBe("denied");
      expect(result.json?.resumed).toBeUndefined();
      expect((await adapter.getApproval("no-resume-deny", "gate", 0))?.status).toBe("denied");
    } finally {
      sqlite.close();
    }
  });
});
