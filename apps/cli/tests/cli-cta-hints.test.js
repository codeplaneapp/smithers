// The CLI's guidance strings must be runnable as written: every suggested
// command has to parse when copy-pasted. These tests pin the fixes for the
// stale-runs hint (#27), approve's detached-run resume note (#24), and logs'
// --from-seq alias (#10).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import {
  createTempRepo,
  pinSqliteBackend,
  runSmithers,
  writeTestWorkflow,
} from "../../../packages/smithers/tests/e2e-helpers.js";

/**
 * @param {ReturnType<typeof createTempRepo>} repo
 */
function openRepoDb(repo) {
  pinSqliteBackend(repo.dir);
  const sqlite = new Database(repo.path("smithers.db"));
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

describe("stale-runs hint prints runnable per-run commands (#27)", () => {
  test("up against an existing run id lists cancel/resume commands with real ids and paths", async () => {
    const repo = createTempRepo();
    writeTestWorkflow(repo);
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      const now = Date.now();
      await adapter.insertRun({
        runId: "stale-1",
        workflowName: "fixture-workflow",
        workflowPath: "workflow.tsx",
        status: "running",
        createdAtMs: now - 60_000,
        startedAtMs: now - 60_000,
        finishedAtMs: null,
        heartbeatAtMs: now - 60_000,
        vcsType: "none",
        vcsRevision: null,
      });
    } finally {
      sqlite.close();
    }
    // Reusing the stale run's id trips the RUN_EXISTS guard AFTER the
    // stale-run warning prints, so no workflow actually executes.
    const result = runSmithers(["up", "workflow.tsx", "--run-id", "stale-1"], {
      cwd: repo.dir,
      format: "json",
    });
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("smithers cancel stale-1");
    expect(result.stderr).toContain("smithers up workflow.tsx --resume --run-id stale-1");
    // The old un-runnable generic hint is gone.
    expect(result.stderr).not.toContain("Use 'smithers cancel' to mark them as cancelled");
  }, 60_000);
});

describe("approve's detached-run note suggests a command that parses (#24)", () => {
  test("note uses `up <workflow> --resume --run-id <runId>`, never nameless `workflow run --resume`", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      const now = Date.now();
      await adapter.insertRun({
        runId: "approve-run",
        workflowName: "fixture-workflow",
        workflowPath: "workflow.tsx",
        status: "waiting-approval",
        createdAtMs: now - 60_000,
        startedAtMs: now - 60_000,
        finishedAtMs: null,
        heartbeatAtMs: null,
        vcsType: "none",
        vcsRevision: null,
      });
      await adapter.insertNode({
        runId: "approve-run",
        nodeId: "gate",
        iteration: 0,
        state: "waiting-approval",
        lastAttempt: null,
        updatedAtMs: now - 30_000,
        outputTable: "",
        label: "Gate",
      });
      await adapter.insertOrUpdateApproval({
        runId: "approve-run",
        nodeId: "gate",
        iteration: 0,
        status: "requested",
        requestedAtMs: now - 30_000,
      });
    } finally {
      sqlite.close();
    }
    const result = runSmithers(["approve", "approve-run"], {
      cwd: repo.dir,
      format: "json",
    });
    expect(result.exitCode).toBe(0);
    expect(result.json.status).toBe("approved");
    expect(result.json.note).toContain("smithers up workflow.tsx --resume --run-id approve-run");
    expect(result.json.note).not.toContain("workflow run --resume");
  }, 60_000);
});

describe("logs --from-seq vs the deprecated --since alias (#10)", () => {
  /**
   * @param {SmithersDb} adapter
   */
  async function seedFinishedRunWithEvents(adapter) {
    const now = Date.now();
    await adapter.insertRun({
      runId: "log-run",
      workflowName: "fixture-workflow",
      workflowPath: "workflow.tsx",
      status: "finished",
      createdAtMs: now - 60_000,
      startedAtMs: now - 60_000,
      finishedAtMs: now - 1_000,
      heartbeatAtMs: null,
      vcsType: "none",
      vcsRevision: null,
    });
    for (const type of ["RunStarted", "RunFinished"]) {
      await adapter.insertEventWithNextSeq({
        runId: "log-run",
        timestampMs: now - 30_000,
        type,
        payloadJson: JSON.stringify({ type, runId: "log-run" }),
      });
    }
  }

  test("--from-seq works and --since still works but prints a deprecation pointer", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      await seedFinishedRunWithEvents(adapter);
    } finally {
      sqlite.close();
    }
    const preferred = runSmithers(["logs", "log-run", "--from-seq", "0", "--no-follow"], {
      cwd: repo.dir,
      format: null,
    });
    expect(preferred.exitCode).toBe(0);
    expect(preferred.stderr).not.toContain("prefer --from-seq");

    const deprecated = runSmithers(["logs", "log-run", "--since", "0", "--no-follow"], {
      cwd: repo.dir,
      format: null,
    });
    expect(deprecated.exitCode).toBe(0);
    expect(deprecated.stderr).toContain("prefer --from-seq");
    // Both spellings mean the same cursor: identical event output.
    expect(deprecated.stdout).toBe(preferred.stdout);
  }, 60_000);
});
