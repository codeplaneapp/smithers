import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
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
      expect(`${run.stdout}${run.stderr}`).toContain("monitor watched-1-monitor watching watched-1");

      const monitor = inspect(repo, "watched-1-monitor");
      expect(monitor.exitCode).toBe(0);
      // Linked in the store, so ps / inspect / the Gateway can show the pairing
      // and `smithers cancel` cascades to it.
      expect(monitor.json?.run?.parentRunId).toBe("watched-1");
      // Dies with the run: its own task would have slept ten minutes, so only
      // teardown can put it in a terminal state this soon.
      expect(await waitForTerminal(repo, "watched-1-monitor")).toBe("cancelled");
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
      const grandchild = inspect(repo, "watched-2-monitor-monitor");
      expect(grandchild.exitCode).not.toBe(0);
      expect(`${grandchild.stdout}${grandchild.stderr}`).toContain("RUN_NOT_FOUND");
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
      expect(inspect(repo, "watched-3-monitor").exitCode).not.toBe(0);
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
      expect(inspect(repo, "watched-4-monitor").exitCode).not.toBe(0);
    },
    TIMEOUT_MS,
  );
});
