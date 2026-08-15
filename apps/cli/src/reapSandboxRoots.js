import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { directorySizeBytes } from "./diskUsage.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const TERMINAL_RUN_STATUSES = new Set(["finished", "failed", "cancelled", "canceled"]);

/**
 * Reclaim workspace-local sandbox transport roots after their owning run is
 * terminal. Unknown and nonterminal runs are always retained.
 *
 * @param {{
 *   cwd: string;
 *   adapter?: Pick<import("@smthrs/db/adapter").SmithersDb, "getRun">;
 *   sandboxDir?: string;
 *   olderThanMs?: number;
 *   nowMs?: number;
 *   dryRun?: boolean;
 *   sizeOf?: (path: string) => Promise<number>;
 *   warn?: (line: string) => void;
 * }} options
 */
export async function reapSandboxRoots(options) {
  const sandboxDir = resolve(options.sandboxDir ?? join(options.cwd, ".smithers", "sandboxes"));
  const olderThanMs = options.olderThanMs ?? 7 * DAY_MS;
  const nowMs = options.nowMs ?? Date.now();
  const dryRun = options.dryRun ?? false;
  const sizeOf = options.sizeOf ?? directorySizeBytes;
  const removed = [];
  const skipped = [];
  let entries;
  try {
    entries = readdirSync(sandboxDir, { withFileTypes: true });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") {
      return { sandboxDir, removed, skipped, bytesFreed: 0, totalBytes: 0, dryRun };
    }
    safeWarn(options.warn, `[smithers] Warning: sandbox GC could not read ${sandboxDir}: ${messageOf(error)}\n`);
    return { sandboxDir, removed, skipped, bytesFreed: 0, totalBytes: 0, dryRun };
  }

  let bytesFreed = 0;
  let totalBytes = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const runId = entry.name;
    const path = join(sandboxDir, runId);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    const bytes = await sizeOf(path);
    totalBytes += bytes;
    let run;
    try {
      run = options.adapter ? await options.adapter.getRun(runId) : undefined;
    } catch (error) {
      skipped.push({ path, runId, bytes, reason: "run-lookup-failed" });
      safeWarn(options.warn, `[smithers] Warning: sandbox GC could not load run ${runId}: ${messageOf(error)}\n`);
      continue;
    }
    if (!run) {
      skipped.push({ path, runId, bytes, reason: "unknown-run" });
      continue;
    }
    const status = String(run.status ?? "").toLowerCase();
    if (!TERMINAL_RUN_STATUSES.has(status)) {
      skipped.push({ path, runId, bytes, reason: `run-${status || "unknown"}` });
      continue;
    }
    const ageFromMs =
      typeof run.finishedAtMs === "number" && Number.isFinite(run.finishedAtMs) ? run.finishedAtMs : stat.mtimeMs;
    if (nowMs - ageFromMs < olderThanMs) {
      skipped.push({ path, runId, bytes, reason: "too-recent" });
      continue;
    }
    try {
      if (!dryRun) rmSync(path, { recursive: true, force: true });
      bytesFreed += bytes;
      removed.push({ path, runId, bytes });
    } catch (error) {
      skipped.push({ path, runId, bytes, reason: "remove-failed" });
      safeWarn(options.warn, `[smithers] Warning: sandbox GC could not remove ${path}: ${messageOf(error)}\n`);
    }
  }
  return { sandboxDir, removed, skipped, bytesFreed, totalBytes, dryRun };
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {((line: string) => void) | undefined} warn @param {string} line */
function safeWarn(warn, line) {
  try {
    (warn ?? ((text) => process.stderr.write(text)))(line);
  } catch {}
}
