// Regression: `smithers supervise -r <oneshotRunId>` used to log
// "Skipping run <id>: workflow file not found at (missing path)" on every poll,
// forever. Oneshot builds its workflow in-process and records no workflow_path,
// so the resume path skipped it — making the recovery tool useless for the
// launch mode most likely to be detached and orphaned.
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { supervisorPollEffect } from "../src/supervisor.js";
import { buildResumeArgs, resumeRunDetached } from "../src/resume-detached.js";
import {
  BUILTIN_RESUME_CONFIG_KEY,
  buildBuiltinResumeConfig,
  parseBuiltinResume,
  resolveResumeTarget,
} from "../src/resume-target.js";

const now = Date.now();

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), sqlite };
}

/** The config a detached `smithers oneshot` durably records. */
function oneshotConfigJson(cwd = "/tmp/project") {
  return JSON.stringify({
    oneshot: { chain: [{ engine: "kimi", model: "kimi-k3" }], review: false, goal: "fix the thing" },
    [BUILTIN_RESUME_CONFIG_KEY]: buildBuiltinResumeConfig({
      command: "oneshot",
      args: ["fix the thing", "--cwd", cwd, "--detach", "false", "--open", "false", "--review", "off"],
      cwd,
    }),
  });
}

/**
 * A stale, orphaned oneshot run: engine heartbeat long expired, owner pid dead,
 * and — the whole point — no workflow_path at all.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {{ configJson?: string | null }} [opts]
 */
async function insertOrphanedOneshotRun(adapter, runId, opts = {}) {
  await adapter.insertRun({
    runId,
    workflowName: "oneshot",
    workflowPath: null,
    status: "running",
    createdAtMs: now - 900_000,
    startedAtMs: now - 900_000,
    heartbeatAtMs: now - 600_000,
    runtimeOwnerId: "pid:999999:owner",
    configJson: opts.configJson === undefined ? oneshotConfigJson() : opts.configJson,
  });
}

describe("resolveResumeTarget", () => {
  test("a workflow file on disk always wins over a built-in descriptor", () => {
    const target = resolveResumeTarget(
      { runId: "r1", workflowPath: "/repo/.smithers/workflows/build.tsx", configJson: oneshotConfigJson() },
      { workflowExists: () => true },
    );
    expect(target).toEqual({
      kind: "workflow-file",
      workflowPath: "/repo/.smithers/workflows/build.tsx",
      cwd: "/repo/.smithers/workflows",
    });
  });

  test("falls back to the built-in descriptor when no workflow file was recorded", () => {
    const target = resolveResumeTarget(
      { runId: "oneshot-1", workflowPath: null, configJson: oneshotConfigJson("/tmp/project") },
      { workflowExists: () => false },
    );
    expect(target).toMatchObject({ kind: "builtin", command: "oneshot", cwd: "/tmp/project" });
  });

  test("returns null when there is neither a file nor a descriptor", () => {
    expect(resolveResumeTarget({ runId: "r1", workflowPath: null }, { workflowExists: () => false })).toBeNull();
    expect(
      resolveResumeTarget(
        { runId: "r1", workflowPath: "/gone/build.tsx", configJson: "{}" },
        { workflowExists: () => false },
      ),
    ).toBeNull();
  });

  test("a malformed config never throws on the supervisor's poll loop", () => {
    expect(parseBuiltinResume("{not json")).toBeNull();
    expect(parseBuiltinResume(JSON.stringify({ builtinResume: { command: "", args: [], cwd: "/x" } }))).toBeNull();
    expect(
      parseBuiltinResume(JSON.stringify({ builtinResume: { command: "oneshot", args: [1], cwd: "/x" } })),
    ).toBeNull();
  });
});

describe("buildResumeArgs", () => {
  test("a built-in run re-runs its own subcommand with the run-identity flags appended", () => {
    expect(
      buildResumeArgs({ kind: "builtin", command: "oneshot", args: ["goal", "--cwd", "/tmp/p"], cwd: "/tmp/p" }, "r9"),
    ).toEqual([
      "oneshot",
      "goal",
      "--cwd",
      "/tmp/p",
      "--run-id",
      "r9",
      "--detach",
      "false",
      "--open",
      "false",
      "--resume",
      "true",
      "--force",
      "true",
    ]);
  });

  test("a workflow-file run still resumes through `up --resume`", () => {
    expect(buildResumeArgs({ kind: "workflow-file", workflowPath: "/w/build.tsx", cwd: "/w" }, "r9")).toEqual([
      "up",
      "/w/build.tsx",
      "--resume",
      "--run-id",
      "r9",
      "-d",
      "--force",
    ]);
  });
});

describe("resumeRunDetached", () => {
  test("rejects a vanished built-in cwd before spawning or creating its log tree", () => {
    const cwd = `/tmp/smithers-missing-resume-cwd-${process.pid}-${Date.now()}`;
    expect(() =>
      resumeRunDetached({ kind: "builtin", command: "oneshot", args: ["goal", "--cwd", cwd], cwd }, "missing-cwd-run"),
    ).toThrow(/recorded cwd is unavailable/);
  });
});

describe("supervise resumes built-in workflow runs", () => {
  test("an orphaned oneshot run with no workflow_path is resumed, not skipped forever", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      await insertOrphanedOneshotRun(adapter, "oneshot-abc");
      /** @type {Array<{ runId: string; target: any }>} */
      const resumed = [];
      const summary = await Effect.runPromise(
        supervisorPollEffect({
          adapter,
          runIds: ["oneshot-abc"],
          staleThresholdMs: 30_000,
          deps: {
            // No file exists for a built-in workflow — that is the whole bug.
            workflowExists: () => false,
            isPidAlive: () => false,
            spawnResumeDetached: (target, runId) => {
              resumed.push({ runId, target });
              return 4242;
            },
          },
        }),
      );

      expect(summary.resumedCount).toBe(1);
      expect(resumed).toHaveLength(1);
      expect(resumed[0].runId).toBe("oneshot-abc");
      expect(resumed[0].target).toMatchObject({ kind: "builtin", command: "oneshot", cwd: "/tmp/project" });
      // The resumed argv must re-enter the SAME run, not start a new one.
      expect(buildResumeArgs(resumed[0].target, "oneshot-abc")).toContain("--resume");
      expect(buildResumeArgs(resumed[0].target, "oneshot-abc")).toContain("oneshot-abc");
    } finally {
      sqlite.close();
    }
  });

  test("a run with neither a workflow file nor a descriptor is still skipped", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      await insertOrphanedOneshotRun(adapter, "oneshot-nodesc", { configJson: null });
      const summary = await Effect.runPromise(
        supervisorPollEffect({
          adapter,
          runIds: ["oneshot-nodesc"],
          staleThresholdMs: 30_000,
          deps: {
            workflowExists: () => false,
            isPidAlive: () => false,
            spawnResumeDetached: () => {
              throw new Error("a run with no way to relaunch must never be resumed");
            },
          },
        }),
      );
      expect(summary.resumedCount).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});
