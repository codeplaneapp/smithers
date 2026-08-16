import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, utimesSync } from "node:fs";
import { capDetachedRunLog } from "../src/detachedRunLogRotation.js";
import { reapDetachedRunLogs } from "../src/reapDetachedRunLogs.js";
import { removeDetachedRunLog } from "../src/removeDetachedRunLog.js";
import {
  createTempRepo,
  pinSqliteBackend,
  runSmithers,
  writeTestWorkflow,
} from "../../../packages/smithers/tests/e2e-helpers.js";

const CLI_COMMAND_TIMEOUT_MS = 120_000;

/**
 * Wait for a detached fixture workflow to settle, then return its persisted
 * run config. Reads can race initial schema creation or the child writer.
 *
 * @param {ReturnType<typeof createTempRepo>} repo
 * @param {string} runId
 */
async function waitForRunConfig(repo, runId) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (existsSync(repo.path("smithers.db"))) {
      const sqlite = new Database(repo.path("smithers.db"), { readonly: true });
      try {
        try {
          const row = sqlite.query("select status, config_json from _smithers_runs where run_id = ?").get(runId);
          if (row?.status && row.status !== "running") {
            return JSON.parse(row.config_json ?? "{}");
          }
        } catch (error) {
          const message = String(error?.message ?? error);
          if (!message.includes("no such table: _smithers_runs") && !message.includes("database is locked")) {
            throw error;
          }
        }
      } finally {
        sqlite.close();
      }
    }
    await Bun.sleep(50);
  }
  throw new Error(`Detached run did not finish: ${runId}`);
}

/**
 * Wait for a detached child to actually exit. The run row flips to a terminal
 * status from inside the child, so a terminal status only means the child is
 * on its way out. Rotation caps the inherited log periodically and once more
 * on `exit`, so the size cap holds for a settled log, not for a log sampled
 * mid-run between sweeps.
 *
 * @param {number | undefined} pid
 */
async function waitForProcessExit(pid) {
  if (typeof pid !== "number") throw new Error("Detached launch did not report a pid");
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`Detached child did not exit: ${pid}`);
}

describe("detached run log paths", () => {
  test(
    "defaults to the workspace .smithers/logs directory and records the exact path",
    async () => {
      const repo = createTempRepo();
      pinSqliteBackend(repo.dir);
      writeTestWorkflow(repo);
      const runId = "default-detached-log";

      const result = runSmithers(["up", "workflow.tsx", "--detach", "--run-id", runId], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: CLI_COMMAND_TIMEOUT_MS,
      });

      const expected = repo.path(".smithers", "logs", `${runId}.log`);
      expect(result.exitCode).toBe(0);
      expect(result.json?.logFile).toBe(expected);
      expect(existsSync(expected)).toBe(true);
      expect((await waitForRunConfig(repo, runId)).logFile).toBe(expected);
    },
    CLI_COMMAND_TIMEOUT_MS,
  );

  test(
    "keeps an explicit --log-dir override and records the override path",
    async () => {
      const repo = createTempRepo();
      pinSqliteBackend(repo.dir);
      writeTestWorkflow(repo);
      const runId = "custom-detached-log";

      const result = runSmithers(["up", "workflow.tsx", "--detach", "--run-id", runId, "--log-dir", "operator-logs"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: CLI_COMMAND_TIMEOUT_MS,
      });

      const expected = repo.path("operator-logs", `${runId}.log`);
      expect(result.exitCode).toBe(0);
      expect(result.json?.logFile).toBe(expected);
      expect(existsSync(expected)).toBe(true);
      expect((await waitForRunConfig(repo, runId)).logFile).toBe(expected);
    },
    CLI_COMMAND_TIMEOUT_MS,
  );

  test(
    "caps a live detached child's inherited log and leaves a truncation notice",
    async () => {
      const repo = createTempRepo();
      pinSqliteBackend(repo.dir);
      repo.write(
        "noisy-workflow.tsx",
        [
          "/** @jsxImportSource smthrs */",
          'import { createSmithers, Workflow, Task } from "smthrs";',
          'import { z } from "zod";',
          'if (!process.argv.includes("--detach")) {',
          '  process.stderr.write("noise:" + "x".repeat(8_000) + "\\n");',
          "  await Bun.sleep(250);",
          "}",
          "const { smithers, outputs } = createSmithers({ result: z.object({ ok: z.boolean() }) });",
          "export default smithers(() => (",
          '  <Workflow name="noisy-workflow">',
          '    <Task id="done" output={outputs.result}>{{ ok: true }}</Task>',
          "  </Workflow>",
          "));",
          "",
        ].join("\n"),
      );
      const runId = "bounded-active-log";

      const result = runSmithers(["up", "noisy-workflow.tsx", "--detach", "--run-id", runId], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: CLI_COMMAND_TIMEOUT_MS,
        env: {
          SMITHERS_LOG_MAX_BYTES: "1024",
          SMITHERS_INTERNAL_DETACHED_LOG_CAP_INTERVAL_MS: "100",
        },
      });
      await waitForRunConfig(repo, runId);
      await waitForProcessExit(result.json?.pid);

      const logFile = repo.path(".smithers", "logs", `${runId}.log`);
      const contents = readFileSync(logFile, "utf8");
      expect(result.exitCode).toBe(0);
      expect(statSync(logFile).size).toBeLessThanOrEqual(1024);
      expect(contents).toContain("older output was truncated");
    },
    CLI_COMMAND_TIMEOUT_MS,
  );
});

describe("detached run log GC", () => {
  test("retention removes only old terminal or old DB-absent logs", async () => {
    const repo = createTempRepo();
    const logDir = repo.path(".smithers", "logs");
    const nowMs = Date.UTC(2026, 6, 17);
    const oldMs = nowMs - 8 * 24 * 60 * 60 * 1_000;
    const youngMs = nowMs - 24 * 60 * 60 * 1_000;
    const runs = new Map([
      ["old-finished", { runId: "old-finished", status: "finished", finishedAtMs: oldMs }],
      ["old-failed", { runId: "old-failed", status: "failed", finishedAtMs: oldMs }],
      ["old-cancelled", { runId: "old-cancelled", status: "cancelled", finishedAtMs: oldMs }],
      ["old-running", { runId: "old-running", status: "running", finishedAtMs: null }],
      ["young-terminal-null", { runId: "young-terminal-null", status: "finished", finishedAtMs: null }],
    ]);
    for (const runId of [...runs.keys(), "old-missing", "young-missing"]) {
      const path = repo.write(`.smithers/logs/${runId}.log`, runId);
      const timestamp = runId === "young-missing" || runId === "young-terminal-null" ? youngMs : oldMs;
      utimesSync(path, new Date(timestamp), new Date(timestamp));
    }

    await reapDetachedRunLogs({
      logDir,
      adapter: { getRun: async (runId) => runs.get(runId) },
      env: {
        SMITHERS_LOG_RETENTION_DAYS: "7",
        SMITHERS_LOG_MAX_TOTAL_BYTES: String(1024 * 1024),
      },
      nowMs,
    });

    expect(existsSync(repo.path(".smithers/logs/old-finished.log"))).toBe(false);
    expect(existsSync(repo.path(".smithers/logs/old-failed.log"))).toBe(false);
    expect(existsSync(repo.path(".smithers/logs/old-cancelled.log"))).toBe(false);
    expect(existsSync(repo.path(".smithers/logs/old-missing.log"))).toBe(false);
    expect(existsSync(repo.path(".smithers/logs/old-running.log"))).toBe(true);
    expect(existsSync(repo.path(".smithers/logs/young-missing.log"))).toBe(true);
    expect(existsSync(repo.path(".smithers/logs/young-terminal-null.log"))).toBe(true);
  });

  test("size cap evicts the oldest eligible terminal log first and keeps active logs", async () => {
    const repo = createTempRepo();
    const logDir = repo.path(".smithers", "logs");
    const nowMs = Date.UTC(2026, 6, 17);
    const oldestMs = nowMs - 3 * 24 * 60 * 60 * 1_000;
    const newerMs = nowMs - 24 * 60 * 60 * 1_000;
    const paths = {
      active: repo.write(".smithers/logs/active.log", "a".repeat(10)),
      oldest: repo.write(".smithers/logs/oldest-terminal.log", "o".repeat(6)),
      newer: repo.write(".smithers/logs/newer-terminal.log", "n".repeat(6)),
      missing: repo.write(".smithers/logs/young-missing.log", "m".repeat(4)),
    };
    utimesSync(paths.active, new Date(oldestMs), new Date(oldestMs));
    utimesSync(paths.oldest, new Date(oldestMs), new Date(oldestMs));
    utimesSync(paths.newer, new Date(newerMs), new Date(newerMs));
    utimesSync(paths.missing, new Date(newerMs), new Date(newerMs));
    const runs = new Map([
      ["active", { runId: "active", status: "running", finishedAtMs: null }],
      ["oldest-terminal", { runId: "oldest-terminal", status: "finished", finishedAtMs: oldestMs }],
      ["newer-terminal", { runId: "newer-terminal", status: "failed", finishedAtMs: newerMs }],
    ]);

    await reapDetachedRunLogs({
      logDir,
      adapter: { getRun: async (runId) => runs.get(runId) },
      env: {
        SMITHERS_LOG_RETENTION_DAYS: "7",
        SMITHERS_LOG_MAX_TOTAL_BYTES: "20",
      },
      nowMs,
    });

    expect(existsSync(paths.active)).toBe(true);
    expect(existsSync(paths.oldest)).toBe(false);
    expect(existsSync(paths.newer)).toBe(true);
    expect(existsSync(paths.missing)).toBe(true);
  });

  test("dry-run reports expired logs without unlinking them", async () => {
    const repo = createTempRepo();
    const logFile = repo.write(".smithers/logs/finished.log", "finished output");
    const nowMs = Date.UTC(2026, 6, 17);
    const oldMs = nowMs - 8 * 24 * 60 * 60 * 1_000;
    utimesSync(logFile, new Date(oldMs), new Date(oldMs));

    const result = await reapDetachedRunLogs({
      logDir: repo.path(".smithers", "logs"),
      adapter: { getRun: async () => ({ status: "finished", finishedAtMs: oldMs }) },
      olderThanMs: 7 * 24 * 60 * 60 * 1_000,
      dryRun: true,
      nowMs,
    });

    expect(result.removed.map((entry) => entry.logFile)).toEqual([logFile]);
    expect(result.bytesFreed).toBe(Buffer.byteLength("finished output"));
    expect(existsSync(logFile)).toBe(true);
  });

  test("a manual minimum age also protects terminal logs from the aggregate size cap", async () => {
    const repo = createTempRepo();
    const logFile = repo.write(".smithers/logs/recent.log", "recent output");
    const nowMs = Date.UTC(2026, 6, 17);
    const finishedAtMs = nowMs - 60_000;

    const result = await reapDetachedRunLogs({
      logDir: repo.path(".smithers", "logs"),
      adapter: { getRun: async () => ({ status: "finished", finishedAtMs }) },
      env: { SMITHERS_LOG_MAX_TOTAL_BYTES: "0" },
      olderThanMs: 24 * 60 * 60 * 1_000,
      minimumAgeForSizeCap: true,
      nowMs,
    });

    expect(result.removed).toHaveLength(0);
    expect(existsSync(logFile)).toBe(true);
  });

  test("manual GC can require a terminal run record before removing an old log", async () => {
    const repo = createTempRepo();
    const logFile = repo.write(".smithers/logs/unknown.log", "unknown output");
    const nowMs = Date.UTC(2026, 6, 17);
    const oldMs = nowMs - 8 * 24 * 60 * 60 * 1_000;
    utimesSync(logFile, new Date(oldMs), new Date(oldMs));

    const result = await reapDetachedRunLogs({
      logDir: repo.path(".smithers", "logs"),
      adapter: { getRun: async () => undefined },
      olderThanMs: 7 * 24 * 60 * 60 * 1_000,
      allowAbsentRuns: false,
      nowMs,
    });

    expect(result.removed).toHaveLength(0);
    expect(existsSync(logFile)).toBe(true);
  });
});

describe("active detached run log cap", () => {
  test("preserves a bounded tail and writes a truncation notice on the inherited inode", () => {
    const repo = createTempRepo();
    const logFile = repo.write(".smithers/logs/active.log", `${"old\n".repeat(2_000)}last-line\n`);
    const fd = openSync(logFile, "a");
    let result;
    try {
      result = capDetachedRunLog({
        logFile,
        fd,
        env: { SMITHERS_LOG_MAX_BYTES: "1024" },
      });
    } finally {
      closeSync(fd);
    }

    const contents = readFileSync(logFile, "utf8");
    expect(result.capped).toBe(true);
    expect(result.beforeBytes).toBeGreaterThan(1024);
    expect(statSync(logFile).size).toBeLessThanOrEqual(1024);
    expect(contents).toContain("older output was truncated");
    expect(contents.endsWith("last-line\n")).toBe(true);
  });

  test("refuses to truncate when the path no longer names the inherited descriptor", () => {
    const repo = createTempRepo();
    const inherited = repo.write(".smithers/logs/inherited.log", "x".repeat(2_000));
    const replacement = repo.write(".smithers/logs/replacement.log", "keep me");
    const fd = openSync(inherited, "a");
    try {
      const result = capDetachedRunLog({
        logFile: replacement,
        fd,
        env: { SMITHERS_LOG_MAX_BYTES: "1024" },
      });
      expect(result.capped).toBe(false);
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(replacement, "utf8")).toBe("keep me");
    expect(statSync(inherited).size).toBe(2_000);
  });
});

test("run deletion cleanup removes the recorded log path", () => {
  const repo = createTempRepo();
  const logFile = repo.write("operator-logs/deleted-run.log", "log contents");

  const result = removeDetachedRunLog(
    {
      runId: "deleted-run",
      configJson: JSON.stringify({ logFile }),
    },
    { cwd: repo.dir },
  );

  expect(result).toEqual({ removed: true, logFile });
  expect(existsSync(logFile)).toBe(false);
});

test("run log cleanup warns on unlink failure without throwing", () => {
  const repo = createTempRepo();
  const logFile = repo.path("operator-logs", "locked-run.log");
  mkdirSync(logFile, { recursive: true });
  const warnings = [];

  const result = removeDetachedRunLog(
    {
      runId: "locked-run",
      configJson: JSON.stringify({ logFile }),
    },
    {
      cwd: repo.dir,
      warn: (line) => warnings.push(line),
    },
  );

  expect(result).toEqual({ removed: false, logFile });
  expect(warnings.join("\n")).toContain("could not remove detached run log");
});
