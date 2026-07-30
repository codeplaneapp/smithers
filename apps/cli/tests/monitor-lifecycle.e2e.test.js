import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

const TIMEOUT_MS = 180_000;

/**
 * A compute-only workflow: no agent, so the lifecycle is what is under test
 * rather than a model. `delayMs` keeps the watched run alive long enough for
 * its monitor to actually start.
 *
 * @param {string} name
 * @param {number} delayMs
 */
function computeWorkflow(name, delayMs) {
  return [
    "/** @jsxImportSource smithers-orchestrator */",
    'import { createSmithers, Workflow, Task } from "smithers-orchestrator";',
    'import { z } from "zod";',
    "",
    "const { smithers, outputs } = createSmithers({",
    `  ${name}: z.object({ ok: z.boolean(), watching: z.string() }),`,
    "});",
    "",
    "export default smithers((ctx) => (",
    `  <Workflow name="${name}">`,
    `    <Task id="${name}-task" output={outputs.${name}}>`,
    `      {async () => {`,
    `        await new Promise((resolve) => setTimeout(resolve, ${delayMs}));`,
    `        return { ok: true, watching: String(ctx.input?.watchRunId ?? "none") };`,
    "      }}",
    "    </Task>",
    "  </Workflow>",
    "));",
    "",
  ].join("\n");
}

function approvalWorkflow(name) {
  return [
    "/** @jsxImportSource smithers-orchestrator */",
    'import { Approval, createSmithers } from "smithers-orchestrator";',
    'import { z } from "zod";',
    "",
    "const { Workflow, smithers, outputs } = createSmithers({",
    "  approval: z.object({ approved: z.boolean() }),",
    "});",
    "",
    "export default smithers(() => (",
    `  <Workflow name="${name}">`,
    '    <Approval id="gate" output={outputs.approval} request={{ title: "Continue?" }} onDeny="fail" />',
    "  </Workflow>",
    "));",
    "",
  ].join("\n");
}

/**
 * A workspace holding one watched workflow and (optionally) its monitor. The
 * monitor sleeps far longer than the run it watches, so "the monitor is
 * terminal once the run finishes" can only be true if teardown really fired.
 *
 * @param {{ withMonitor: boolean }} options
 */
function fixture({ withMonitor }) {
  const repo = createTempRepo();
  mkdirSync(join(repo.dir, ".smithers", "workflows"), { recursive: true });
  pinSqliteBackend(repo.dir);
  repo.write(".smithers/workflows/watched.tsx", computeWorkflow("watched", 5_000));
  if (withMonitor) {
    mkdirSync(join(repo.dir, ".smithers", "monitor"), { recursive: true });
    repo.write(".smithers/monitor/watched.tsx", computeWorkflow("watcher", 600_000));
  }
  return repo;
}

/** @param {import("../../../packages/smithers/tests/e2e-helpers.js").TempRepo} repo */
function inspect(repo, runId) {
  return runSmithers(["inspect", runId], { cwd: repo.dir, format: "json", timeoutMs: 60_000 });
}

/** @param {import("../../../packages/smithers/tests/e2e-helpers.js").TempRepo} repo */
function childRunIds(repo, parentRunId) {
  const sqlite = new Database(repo.path("smithers.db"), { readonly: true });
  try {
    return sqlite
      .query("SELECT run_id FROM _smithers_runs WHERE parent_run_id = ? ORDER BY created_at_ms")
      .all(parentRunId)
      .map((row) => row.run_id);
  } finally {
    sqlite.close();
  }
}

const TERMINAL = new Set(["finished", "failed", "cancelled", "continued"]);

/**
 * Teardown is a GRACEFUL cancel: a live monitor with a fresh heartbeat gets a
 * durable cancel request, and its own engine aborts and writes the terminal
 * status a moment later. So poll for the transition rather than reading once
 * and racing it.
 *
 * @param {import("../../../packages/smithers/tests/e2e-helpers.js").TempRepo} repo
 * @param {string} runId
 */
async function waitForTerminal(repo, runId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = inspect(repo, runId).json?.run?.status;
    if (last && TERMINAL.has(last)) return last;
    await Bun.sleep(500);
  }
  return last;
}

describe("monitor workflow lifecycle", () => {
  test(
    "a discovered monitor starts with the run, is linked to it, and dies when it finishes",
    async () => {
      const repo = fixture({ withMonitor: true });
      const run = runSmithers(["up", ".smithers/workflows/watched.tsx", "--run-id", "watched-1", "--no-report"], {
        cwd: repo.dir,
        timeoutMs: TIMEOUT_MS,
      });
      expect(run.exitCode).toBe(0);
      // Starts with the run.
      expect(`${run.stdout}${run.stderr}`).toContain("watching watched-1");

      const [monitorRunId] = childRunIds(repo, "watched-1");
      const monitor = inspect(repo, monitorRunId);
      expect(monitor.exitCode).toBe(0);
      // Linked in the store, so ps / inspect / the Gateway can show the pairing
      // and `smithers cancel` cascades to it.
      expect(monitor.json?.run?.parentRunId).toBe("watched-1");
      // Dies with the run: its own task would have slept ten minutes, so only
      // teardown can put it in a terminal state this soon.
      expect(await waitForTerminal(repo, monitorRunId)).toBe("cancelled");
    },
    TIMEOUT_MS,
  );

  test(
    "a monitor never spawns a monitor of its own",
    async () => {
      const repo = fixture({ withMonitor: true });
      // The monitor watches `watched`, and is itself named `watched.tsx`; a
      // registry-only guard would let it match itself and recurse forever.
      const run = runSmithers(["up", ".smithers/workflows/watched.tsx", "--run-id", "watched-2", "--no-report"], {
        cwd: repo.dir,
        timeoutMs: TIMEOUT_MS,
      });
      expect(run.exitCode).toBe(0);
      const [monitorRunId] = childRunIds(repo, "watched-2");
      expect(childRunIds(repo, monitorRunId)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "--no-monitor launches no monitor at all",
    async () => {
      const repo = fixture({ withMonitor: true });
      const run = runSmithers(
        ["up", ".smithers/workflows/watched.tsx", "--run-id", "watched-3", "--no-monitor", "--no-report"],
        { cwd: repo.dir, timeoutMs: TIMEOUT_MS },
      );
      expect(run.exitCode).toBe(0);
      expect(`${run.stdout}${run.stderr}`).not.toContain("watching watched-3");
      expect(childRunIds(repo, "watched-3")).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "a workspace with no monitor files behaves exactly as before",
    async () => {
      const repo = fixture({ withMonitor: false });
      const run = runSmithers(["up", ".smithers/workflows/watched.tsx", "--run-id", "watched-4", "--no-report"], {
        cwd: repo.dir,
        timeoutMs: TIMEOUT_MS,
      });
      expect(run.exitCode).toBe(0);
      expect(`${run.stdout}${run.stderr}`).not.toContain("watching watched-4");
      expect(childRunIds(repo, "watched-4")).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test("a missing bun executable degrades monitor launch without killing or delaying the watched run", () => {
    const repo = fixture({ withMonitor: true });
    const startedAt = Date.now();
    const run = runSmithers(["up", ".smithers/workflows/watched.tsx", "--run-id", "watched-no-bun", "--no-report"], {
      cwd: repo.dir,
      env: { PATH: "" },
      timeoutMs: 30_000,
    });
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(`${run.stdout}${run.stderr}`).toContain("continues without it");
    expect(Date.now() - startedAt).toBeLessThan(20_000);
    expect(childRunIds(repo, "watched-no-bun")).toEqual([]);
  }, 30_000);

  test(
    "a parked run keeps its monitor and a later resume adopts it",
    async () => {
      const repo = createTempRepo();
      mkdirSync(join(repo.dir, ".smithers", "workflows"), { recursive: true });
      mkdirSync(join(repo.dir, ".smithers", "monitor"), { recursive: true });
      pinSqliteBackend(repo.dir);
      repo.write(".smithers/workflows/watched.tsx", approvalWorkflow("watched"));
      repo.write(".smithers/monitor/watched.tsx", computeWorkflow("watcher", 600_000));

      const parked = runSmithers(
        ["up", ".smithers/workflows/watched.tsx", "--run-id", "watched-parked", "--no-report"],
        { cwd: repo.dir, timeoutMs: TIMEOUT_MS },
      );
      expect(parked.exitCode, `${parked.stdout}\n${parked.stderr}`).toBe(3);

      let monitorRunId;
      let monitorStatus;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        [monitorRunId] = childRunIds(repo, "watched-parked");
        monitorStatus = monitorRunId ? inspect(repo, monitorRunId).json?.run?.status : undefined;
        if (monitorStatus === "running") break;
        await Bun.sleep(250);
      }
      expect(monitorStatus).toBe("running");

      const approved = runSmithers(["approve", "watched-parked", "--node", "gate"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 60_000,
      });
      expect(approved.exitCode, `${approved.stdout}\n${approved.stderr}`).toBe(0);
      const resumed = runSmithers(
        ["up", ".smithers/workflows/watched.tsx", "--run-id", "watched-parked", "--resume", "--force", "--no-report"],
        { cwd: repo.dir, timeoutMs: TIMEOUT_MS },
      );
      expect(resumed.exitCode, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);
      expect(`${resumed.stdout}${resumed.stderr}`).toContain("already watching watched-parked; adopted");
      expect(childRunIds(repo, "watched-parked")).toEqual([monitorRunId]);
      expect(await waitForTerminal(repo, monitorRunId)).toBe("cancelled");
    },
    TIMEOUT_MS,
  );

  test(
    "a post-launch resume rejection tears the monitor child down",
    async () => {
      const repo = createTempRepo();
      mkdirSync(join(repo.dir, ".smithers", "workflows"), { recursive: true });
      mkdirSync(join(repo.dir, ".smithers", "monitor"), { recursive: true });
      pinSqliteBackend(repo.dir);
      const originalWorkflow = approvalWorkflow("watched");
      repo.write(".smithers/workflows/watched.tsx", originalWorkflow);
      repo.write(".smithers/monitor/watched.tsx", computeWorkflow("watcher", 600_000));

      const parked = runSmithers(
        ["up", ".smithers/workflows/watched.tsx", "--run-id", "watched-rejected", "--no-report"],
        { cwd: repo.dir, timeoutMs: TIMEOUT_MS },
      );
      expect(parked.exitCode, `${parked.stdout}\n${parked.stderr}`).toBe(3);
      let monitorRunId;
      let monitorStatus;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        [monitorRunId] = childRunIds(repo, "watched-rejected");
        monitorStatus = monitorRunId ? inspect(repo, monitorRunId).json?.run?.status : undefined;
        if (monitorStatus === "running") break;
        await Bun.sleep(250);
      }
      expect(monitorStatus).toBe("running");

      const approved = runSmithers(["approve", "watched-rejected", "--node", "gate"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 60_000,
      });
      expect(approved.exitCode, `${approved.stdout}\n${approved.stderr}`).toBe(0);
      repo.write(".smithers/workflows/watched.tsx", `${originalWorkflow}\n// changed after the durable run\n`);
      const rejected = runSmithers(
        ["up", ".smithers/workflows/watched.tsx", "--run-id", "watched-rejected", "--resume", "--force", "--no-report"],
        { cwd: repo.dir, timeoutMs: TIMEOUT_MS },
      );
      expect(rejected.exitCode).toBe(1);
      expect(`${rejected.stdout}${rejected.stderr}`).toContain("durable metadata changed");

      const sqlite = new Database(repo.path("smithers.db"), { readonly: true });
      try {
        expect(sqlite.query("SELECT status FROM _smithers_runs WHERE run_id = ?").get(monitorRunId)).toEqual({
          status: "cancelled",
        });
      } finally {
        sqlite.close();
      }
    },
    TIMEOUT_MS,
  );
});
