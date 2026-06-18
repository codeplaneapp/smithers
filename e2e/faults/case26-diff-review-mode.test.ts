import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { withTaskRuntime } from "@smithers-orchestrator/driver/task-runtime";
import { executeSandbox } from "@smithers-orchestrator/sandbox";
import { getNodeDiffRoute } from "@smithers-orchestrator/server";

const RUN_ID = "run-case26";
const NODE_ID = "edit-readme";
const ITERATION = 0;
const SANDBOX_ID = "sandbox-review";

function tempPath(name: string): string {
  return join(
    tmpdir(),
    `smithers-case26-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

function createDiffReviewWorkflow(dbPath: string) {
  const { smithers, Workflow, Task, outputs, db } = createSmithers(
    {
      input: z.object({ value: z.number().optional() }),
      edited: z.object({ ok: z.boolean() }),
    },
    { dbPath },
  );
  const workflow = smithers((ctx) =>
    React.createElement(
      Workflow,
      { name: "case26-workflow" },
      React.createElement(Task, {
        id: NODE_ID,
        output: outputs.edited,
        children: { ok: Boolean(ctx.input.value ?? true) },
      }),
    ),
  );
  ensureSmithersTables(db);
  return { workflow, db, adapter: new SmithersDb(db) };
}

type DiffReviewDb = ReturnType<typeof createDiffReviewWorkflow>["db"];

async function runSandboxWithPatch(
  db: DiffReviewDb,
  rootDir: string,
  options: { autoAcceptDiffs: boolean },
): Promise<unknown> {
  return withTaskRuntime(
    {
      runId: RUN_ID,
      stepId: NODE_ID,
      attempt: 1,
      iteration: ITERATION,
      signal: new AbortController().signal,
      db: db as unknown as Parameters<typeof withTaskRuntime>[0]["db"],
      heartbeat: () => undefined,
      lastHeartbeat: null,
    },
    () =>
      executeSandbox({
        sandboxId: SANDBOX_ID,
        provider: {
          id: `case26-provider-${options.autoAcceptDiffs ? "accept" : "reject"}`,
          run: async () => ({
            status: "finished",
            output: { ok: true },
            runId: "child-case26",
            diffBundle: {
              seq: 1,
              baseRef: "base-ref",
              patches: [
                {
                  path: "README.md",
                  operation: "modify",
                  diff: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n",
                },
              ],
            },
          }),
        },
        runtime: undefined,
        parentWorkflow: { build: () => null },
        workflow: { build: () => null },
        executeChildWorkflow: async () => ({ runId: "unused", status: "finished", output: {} }),
        input: { prompt: "edit readme" },
        rootDir,
        allowNetwork: false,
        maxOutputBytes: 1024,
        toolTimeoutMs: 250,
        reviewDiffs: true,
        autoAcceptDiffs: options.autoAcceptDiffs,
        applyDiffBundle: async (_diffBundle, workspaceRoot) => {
          writeFileSync(join(workspaceRoot, "README.md"), "new\n", "utf8");
        },
      }),
  );
}

async function eventTypes(adapter: SmithersDb): Promise<string[]> {
  const rows = await adapter.listEvents(RUN_ID, -1);
  return rows.map((row) => String(row.type));
}

describe("case 26: diff-review-required sandbox mode", () => {
  test("real sandbox rejects unreviewed diffs and only applies patches after auto-accept", async () => {
    const dbPath = tempPath("review.db");
    const rootDir = tempPath("workspace");
    const { db, adapter } = createDiffReviewWorkflow(dbPath);

    try {
      await expect(runSandboxWithPatch(db, rootDir, { autoAcceptDiffs: false })).rejects.toThrow(
        "require review approval",
      );

      expect(existsSync(join(rootDir, "README.md"))).toBe(false);
      expect(await eventTypes(adapter)).toEqual([
        "SandboxCreated",
        "SandboxShipped",
        "SandboxBundleReceived",
        "SandboxDiffReviewRequested",
        "SandboxDiffRejected",
        "SandboxFailed",
      ]);

      const acceptedOutput = await runSandboxWithPatch(db, rootDir, { autoAcceptDiffs: true });
      expect(acceptedOutput).toEqual({ ok: true });
      expect(readFileSync(join(rootDir, "README.md"), "utf8")).toBe("new\n");
      expect(await eventTypes(adapter)).toEqual([
        "SandboxCreated",
        "SandboxShipped",
        "SandboxBundleReceived",
        "SandboxDiffReviewRequested",
        "SandboxDiffRejected",
        "SandboxFailed",
        "SandboxCreated",
        "SandboxShipped",
        "SandboxBundleReceived",
        "SandboxDiffReviewRequested",
        "SandboxDiffAccepted",
        "SandboxCompleted",
      ]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }
  });

  test("real getNodeDiff path persists through the product node-diff cache", async () => {
    const dbPath = tempPath("node-diff.db");
    const { adapter } = createDiffReviewWorkflow(dbPath);

    try {
      await adapter.insertRun({
        runId: RUN_ID,
        workflowName: "case26-workflow",
        status: "running",
        createdAtMs: Date.now(),
        vcsRevision: "base-ref",
        vcsType: "jj",
      });
      await adapter.insertNode({
        runId: RUN_ID,
        nodeId: NODE_ID,
        iteration: ITERATION,
        state: "finished",
        lastAttempt: 1,
        updatedAtMs: Date.now(),
        outputTable: "edited",
        label: null,
      });
      await adapter.insertAttempt({
        runId: RUN_ID,
        nodeId: NODE_ID,
        iteration: ITERATION,
        attempt: 1,
        state: "finished",
        startedAtMs: Date.now() - 1_000,
        finishedAtMs: Date.now() - 500,
        heartbeatAtMs: null,
        heartbeatDataJson: null,
        errorJson: null,
        jjPointer: "target-ref",
        responseText: null,
        jjCwd: "/tmp/case26-node-diff",
        cached: false,
        metaJson: null,
      });

      const result = await getNodeDiffRoute({
        runId: RUN_ID,
        nodeId: NODE_ID,
        iteration: ITERATION,
        resolveRun: async (runId) => (runId === RUN_ID ? { adapter } : null),
        computeDiffBundleBetweenRefsImpl: async (baseRef, targetRef, cwd, seq) => ({
          seq: seq ?? 1,
          baseRef,
          patches: [
            {
              path: "README.md",
              operation: "modify",
              diff: `diff:${baseRef}->${targetRef}@${cwd}`,
            },
          ],
        }),
        resolveCommitPointerImpl: async (pointer) => pointer,
        emitEffect: async () => undefined,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.baseRef).toBe("base-ref");
        expect("patches" in result.payload).toBe(true);
        if ("patches" in result.payload) {
          expect(result.payload.patches).toHaveLength(1);
        }
      }
      const cached = await adapter.getNodeDiffCache(RUN_ID, NODE_ID, ITERATION, "base-ref");
      expect(cached).toBeDefined();
      expect(JSON.parse(cached!.diffJson)).toEqual(result.ok ? result.payload : {});
    } finally {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }
  });
});
