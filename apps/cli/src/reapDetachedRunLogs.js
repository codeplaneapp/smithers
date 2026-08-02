import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { cliWorkspace } from "./cliWorkspace.js";
import { findAndOpenDb } from "./find-db.js";
import { resolveDetachedRunLogFile } from "./resolveDetachedRunLogFile.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
// Detached logs are retained for 7 days by default. Override with
// SMITHERS_LOG_RETENTION_DAYS (zero is allowed).
const DEFAULT_LOG_RETENTION_DAYS = 7;
// The managed .smithers/logs directory is capped at 1 GiB by default. Override
// with SMITHERS_LOG_MAX_TOTAL_BYTES (zero is allowed).
const DEFAULT_LOG_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const TERMINAL_RUN_STATUSES = new Set(["finished", "failed", "cancelled", "canceled"]);
const RUN_LOOKUP_BATCH_SIZE = 32;

/**
 * @param {string | undefined} raw
 * @param {number} fallback
 * @param {boolean} integer
 */
function nonNegativeEnvNumber(raw, fallback, integer = false) {
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return integer ? Math.floor(parsed) : parsed;
}

/**
 * Opportunistically reclaim detached stdout/stderr logs in the managed
 * `.smithers/logs` directory. Active/nonterminal runs are always protected.
 * A DB-absent log is protected until it crosses the retention window.
 *
 * The optional seams keep filesystem behavior and environment limits
 * deterministic in tests. Passing `logDir` changes only the directory this
 * invocation manages; CLI `--log-dir` overrides are deliberately not fed here
 * because operator-owned directories must retain their existing semantics.
 *
 * @param {{
 *   cwd?: string;
 *   logDir?: string;
 *   adapter?: Pick<import("@smthrs/db/adapter").SmithersDb, "getRun">;
 *   env?: NodeJS.ProcessEnv;
 *   nowMs?: number;
 *   warn?: (line: string) => void;
 * }} [options]
 */
export async function reapDetachedRunLogs(options = {}) {
  const cwd = options.cwd ?? cliWorkspace.cwd();
  const logDir = options.logDir ?? dirname(resolveDetachedRunLogFile("gc-probe", { cwd }));
  const env = options.env ?? process.env;
  const nowMs = options.nowMs ?? Date.now();
  const warn = options.warn ?? ((line) => process.stderr.write(line));
  const retentionDays = nonNegativeEnvNumber(env.SMITHERS_LOG_RETENTION_DAYS, DEFAULT_LOG_RETENTION_DAYS);
  const maxTotalBytes = nonNegativeEnvNumber(env.SMITHERS_LOG_MAX_TOTAL_BYTES, DEFAULT_LOG_MAX_TOTAL_BYTES, true);
  const cutoffMs = nowMs - retentionDays * DAY_MS;
  const removed = [];
  let dirEntries;
  try {
    dirEntries = readdirSync(logDir, { withFileTypes: true });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") {
      return { removed, bytesFreed: 0, totalBytes: 0, logDir };
    }
    safeWarn(
      warn,
      `[smithers] Warning: detached run log GC could not read ${logDir}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return { removed, bytesFreed: 0, totalBytes: 0, logDir };
  }
  const logs = [];
  for (const entry of dirEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
    const runId = entry.name.slice(0, -4);
    if (!runId) continue;
    const logFile = resolve(logDir, entry.name);
    try {
      const stat = lstatSync(logFile);
      if (stat.isFile()) {
        logs.push({ runId, logFile, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== "ENOENT") {
        safeWarn(
          warn,
          `[smithers] Warning: detached run log GC could not inspect ${logFile}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }
  if (logs.length === 0) {
    return { removed, bytesFreed: 0, totalBytes: 0, logDir };
  }

  let adapter = options.adapter;
  let cleanup = () => {};
  if (!adapter) {
    try {
      const opened = await findAndOpenDb(cwd);
      adapter = opened.adapter;
      cleanup = opened.cleanup;
    } catch (error) {
      // First launch in a workspace has no run store yet. Without an
      // authoritative DB, keep every log and let the next launch retry.
      if (/** @type {{ code?: string }} */ (error)?.code !== "CLI_DB_NOT_FOUND") {
        safeWarn(
          warn,
          `[smithers] Warning: detached run log GC skipped: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      return {
        removed,
        bytesFreed: 0,
        totalBytes: logs.reduce((sum, log) => sum + log.size, 0),
        logDir,
      };
    }
  }

  const runs = new Map();
  try {
    for (let offset = 0; offset < logs.length; offset += RUN_LOOKUP_BATCH_SIZE) {
      const batch = logs.slice(offset, offset + RUN_LOOKUP_BATCH_SIZE);
      const rows = await Promise.all(batch.map(async (log) => [log.runId, await adapter.getRun(log.runId)]));
      for (const [runId, run] of rows) {
        runs.set(runId, run);
      }
    }
  } catch (error) {
    safeWarn(
      warn,
      `[smithers] Warning: detached run log GC skipped: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return {
      removed,
      bytesFreed: 0,
      totalBytes: logs.reduce((sum, log) => sum + log.size, 0),
      logDir,
    };
  } finally {
    try {
      cleanup();
    } catch (error) {
      safeWarn(
        warn,
        `[smithers] Warning: detached run log GC store cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  const candidates = logs.map((log) => {
    const run = runs.get(log.runId);
    const terminal = TERMINAL_RUN_STATUSES.has(String(run?.status ?? "").toLowerCase());
    const terminalAtMs =
      typeof run?.finishedAtMs === "number" && Number.isFinite(run.finishedAtMs) ? run.finishedAtMs : null;
    const ageAtMs = terminal && terminalAtMs !== null ? terminalAtMs : log.mtimeMs;
    const absentAndOld = !run && log.mtimeMs < cutoffMs;
    return {
      ...log,
      terminal,
      ageAtMs,
      expired: (terminal && ageAtMs < cutoffMs) || absentAndOld,
      capEligible: terminal || absentAndOld,
    };
  });
  let totalBytes = candidates.reduce((sum, log) => sum + log.size, 0);
  let bytesFreed = 0;
  const deleted = new Set();
  const failed = new Set();

  const remove = (candidate, reason) => {
    try {
      unlinkSync(candidate.logFile);
      deleted.add(candidate.logFile);
      totalBytes -= candidate.size;
      bytesFreed += candidate.size;
      removed.push({ runId: candidate.runId, logFile: candidate.logFile, bytes: candidate.size, reason });
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") {
        deleted.add(candidate.logFile);
        totalBytes -= candidate.size;
        bytesFreed += candidate.size;
        return;
      }
      failed.add(candidate.logFile);
      safeWarn(
        warn,
        `[smithers] Warning: detached run log GC could not remove ${candidate.logFile}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  };

  for (const candidate of candidates.filter((entry) => entry.expired).sort(oldestFirst)) {
    remove(candidate, "retention");
  }
  for (const candidate of candidates.filter((entry) => entry.capEligible).sort(oldestFirst)) {
    if (totalBytes <= maxTotalBytes) break;
    if (!deleted.has(candidate.logFile) && !failed.has(candidate.logFile)) {
      remove(candidate, "size-cap");
    }
  }
  return { removed, bytesFreed, totalBytes: Math.max(0, totalBytes), logDir };
}

/** @param {{ mtimeMs: number; logFile: string }} left @param {{ mtimeMs: number; logFile: string }} right */
function oldestFirst(left, right) {
  return left.mtimeMs - right.mtimeMs || left.logFile.localeCompare(right.logFile);
}

/** @param {(line: string) => void} warn @param {string} line */
function safeWarn(warn, line) {
  try {
    warn(line);
  } catch {
    // GC is opportunistic and must never block a detached launch.
  }
}
