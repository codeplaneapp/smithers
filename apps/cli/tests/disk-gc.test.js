import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { reapSandboxRoots } from "../src/reapSandboxRoots.js";
import { reapUnmanagedScratch } from "../src/reapUnmanagedScratch.js";
import {
  createTempRepo,
  pinSqliteBackend,
  runSmithers,
  writeTestWorkflow,
} from "../../../packages/smithers/tests/e2e-helpers.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const CLI_COMMAND_TIMEOUT_MS = 120_000;

describe("sandbox root GC", () => {
  test("removes only old terminal-run roots", async () => {
    const repo = createTempRepo();
    const nowMs = Date.UTC(2026, 7, 15);
    const oldMs = nowMs - 8 * DAY_MS;
    const youngMs = nowMs - DAY_MS;
    const runs = new Map([
      ["finished", { status: "finished", finishedAtMs: oldMs }],
      ["failed", { status: "failed", finishedAtMs: oldMs }],
      ["running", { status: "running", finishedAtMs: null }],
      ["recent", { status: "finished", finishedAtMs: youngMs }],
    ]);
    for (const runId of [...runs.keys(), "missing"]) {
      const path = repo.path(".smithers", "sandboxes", runId);
      mkdirSync(join(path, "sandbox-a"), { recursive: true });
      repo.write(`.smithers/sandboxes/${runId}/sandbox-a/result`, runId);
      utimesSync(path, new Date(oldMs), new Date(oldMs));
    }

    const result = await reapSandboxRoots({
      cwd: repo.dir,
      adapter: { getRun: async (runId) => runs.get(runId) },
      olderThanMs: 7 * DAY_MS,
      nowMs,
      sizeOf: async () => 10,
    });

    expect(result.removed.map((entry) => entry.runId)).toEqual(["failed", "finished"]);
    expect(existsSync(repo.path(".smithers/sandboxes/failed"))).toBe(false);
    expect(existsSync(repo.path(".smithers/sandboxes/finished"))).toBe(false);
    expect(existsSync(repo.path(".smithers/sandboxes/running"))).toBe(true);
    expect(existsSync(repo.path(".smithers/sandboxes/recent"))).toBe(true);
    expect(existsSync(repo.path(".smithers/sandboxes/missing"))).toBe(true);
    expect(result.skipped.map((entry) => entry.reason).sort()).toEqual(["run-running", "too-recent", "unknown-run"]);
  });

  test("dry-run leaves an eligible sandbox root intact", async () => {
    const repo = createTempRepo();
    const path = repo.path(".smithers", "sandboxes", "done");
    mkdirSync(path, { recursive: true });

    const result = await reapSandboxRoots({
      cwd: repo.dir,
      adapter: { getRun: async () => ({ status: "finished", finishedAtMs: 0 }) },
      olderThanMs: 0,
      dryRun: true,
      sizeOf: async () => 42,
    });

    expect(result.removed).toEqual([{ path, runId: "done", bytes: 42 }]);
    expect(existsSync(path)).toBe(true);
  });
});

describe("legacy campaign scratch GC", () => {
  test("requires opt-in and a successful live-process guard", async () => {
    const repo = createTempRepo();
    const tempRoot = repo.path("tmp");
    const oldLane = join(tempRoot, "smithers", "old-lane");
    const liveLane = join(tempRoot, "smithers", "live-lane");
    const previous = join(tempRoot, "upgrade-smthrs-run.previous-1");
    const nowMs = Date.UTC(2026, 7, 15);
    const oldMs = nowMs - 8 * DAY_MS;
    for (const path of [oldLane, liveLane, previous]) {
      mkdirSync(path, { recursive: true });
      utimesSync(path, new Date(oldMs), new Date(oldMs));
    }

    const inventory = await reapUnmanagedScratch({
      tempRoots: [tempRoot],
      olderThanMs: 7 * DAY_MS,
      nowMs,
      liveCwds: [],
      sizeOf: async () => 10,
    });
    expect(inventory.removed).toHaveLength(0);
    expect(inventory.skipped.every((entry) => entry.reason === "requires-include-unmanaged")).toBe(true);

    const result = await reapUnmanagedScratch({
      tempRoots: [tempRoot],
      includeUnmanaged: true,
      olderThanMs: 7 * DAY_MS,
      nowMs,
      liveCwds: [join(liveLane, "repo")],
      sizeOf: async () => 10,
    });
    expect(result.removed.map((entry) => entry.path)).toEqual([oldLane, previous]);
    expect(existsSync(oldLane)).toBe(false);
    expect(existsSync(previous)).toBe(false);
    expect(existsSync(liveLane)).toBe(true);
    expect(result.skipped).toEqual([{ path: liveLane, bytes: 10, reason: "live-process" }]);
  });

  test("keeps every unmanaged path when live process inventory is unavailable", async () => {
    const repo = createTempRepo();
    const tempRoot = repo.path("tmp");
    const path = join(tempRoot, "smithers", "unknown-use");
    mkdirSync(path, { recursive: true });
    utimesSync(path, new Date(0), new Date(0));

    const result = await reapUnmanagedScratch({
      tempRoots: [tempRoot],
      includeUnmanaged: true,
      olderThanMs: 0,
      liveCwds: null,
      sizeOf: async () => 1,
    });

    expect(result.skipped).toEqual([{ path, bytes: 1, reason: "live-process-check-unavailable" }]);
    expect(existsSync(path)).toBe(true);
  });
});

test(
  "smithers gc reclaims finished-run logs and sandbox roots through the real CLI and store",
  () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    writeTestWorkflow(repo);
    const runId = "gc-finished-run";
    const run = runSmithers(["up", "workflow.tsx", "--run-id", runId], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: CLI_COMMAND_TIMEOUT_MS,
    });
    expect(run.exitCode).toBe(0);
    const logFile = repo.write(`.smithers/logs/${runId}.log`, "old detached output");
    const legacyLogFile = repo.write(`.smithers/workflows/${runId}.log`, "old legacy detached output");
    const sandboxRoot = repo.path(".smithers", "sandboxes", runId);
    mkdirSync(sandboxRoot, { recursive: true });
    repo.write(`.smithers/sandboxes/${runId}/result`, "old sandbox output");

    const gc = runSmithers(["gc", "--older-than", "1ms"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: CLI_COMMAND_TIMEOUT_MS,
    });

    expect(gc.exitCode).toBe(0);
    expect(gc.json?.logs?.removed.map((entry) => entry.runId)).toContain(runId);
    expect(gc.json?.legacyLogs?.removed.map((entry) => entry.runId)).toContain(runId);
    expect(gc.json?.sandboxes?.removed.map((entry) => entry.runId)).toContain(runId);
    expect(gc.json?.disk?.before?.totalBytes).toBeGreaterThan(0);
    expect(existsSync(logFile)).toBe(false);
    expect(existsSync(legacyLogFile)).toBe(false);
    expect(existsSync(sandboxRoot)).toBe(false);
  },
  CLI_COMMAND_TIMEOUT_MS,
);
