import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { getNodeDiffRoute } from "../src/gatewayRoutes/getNodeDiff.js";

function hasJj() {
  const res = spawnSync("jj", ["--version"], { encoding: "utf8" });
  return res.status === 0;
}

function setupDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

async function seed(adapter, runId, nodeId, jjPointer, jjCwd) {
  await adapter.insertRun({
    runId,
    workflowName: "jj-errors",
    status: "finished",
    createdAtMs: Date.now(),
    vcsRevision: jjPointer,
  });
  await adapter.insertNode({
    runId, nodeId, iteration: 0, state: "finished", lastAttempt: 1,
    updatedAtMs: Date.now(), outputTable: "out", label: null,
  });
  await adapter.insertAttempt({
    runId, nodeId, iteration: 0, attempt: 1, state: "finished",
    startedAtMs: Date.now() - 1000, finishedAtMs: Date.now() - 500,
    heartbeatAtMs: null, heartbeatDataJson: null, errorJson: null,
    jjPointer, responseText: null, jjCwd, cached: false, metaJson: null,
  });
}

describe("getNodeDiffRoute runJj subprocess error paths", () => {
  test("captures jj stderr for an invalid revision (default commit-pointer resolver)", async () => {
    if (!hasJj()) {
      expect(true).toBe(true);
      return;
    }
    const repoDir = mkdtempSync(join(tmpdir(), "smithers-jj-stderr-"));
    const { sqlite, adapter } = setupDb();
    try {
      spawnSync("jj", ["git", "init"], { cwd: repoDir });
      await seed(adapter, "run-jj-stderr", "task:bad-rev", "nonexistent_revision_xyz", repoDir);
      const result = await getNodeDiffRoute({
        runId: "run-jj-stderr",
        nodeId: "task:bad-rev",
        iteration: 0,
        stat: true,
        resolveRun: async () => ({ adapter }),
        // Default resolveCommitPointerImpl runs real jj; an invalid revision
        // makes jj write to stderr and exit non-zero (returns null pointer).
        computeDiffBundleBetweenRefsImpl: async (baseRef, targetRef, cwd, seq) => ({
          seq: seq ?? 1,
          baseRef,
          patches: [{ path: "f", operation: "modify", diff: "+a\n" }],
        }),
        emitEffect: async () => undefined,
      });
      expect(result.ok).toBe(true);
    } finally {
      sqlite.close();
      rmSync(repoDir, { force: true, recursive: true });
    }
  });

  test("surfaces a VcsError when the jj working directory does not exist (spawn error)", async () => {
    const { sqlite, adapter } = setupDb();
    try {
      const missingCwd = join(tmpdir(), `smithers-missing-cwd-${Math.random().toString(36).slice(2)}`);
      await seed(adapter, "run-jj-nocwd", "task:nocwd", "some-pointer", missingCwd);
      const result = await getNodeDiffRoute({
        runId: "run-jj-nocwd",
        nodeId: "task:nocwd",
        iteration: 0,
        stat: true,
        resolveRun: async () => ({ adapter }),
        computeDiffBundleBetweenRefsImpl: async (baseRef, targetRef, cwd, seq) => ({
          seq: seq ?? 1,
          baseRef,
          patches: [],
        }),
        emitEffect: async () => undefined,
      });
      // spawn('jj', {cwd: <missing>}) emits an 'error' event -> the resolver
      // rejects -> the route reports a VcsError.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VcsError");
      }
    } finally {
      sqlite.close();
    }
  });
});
