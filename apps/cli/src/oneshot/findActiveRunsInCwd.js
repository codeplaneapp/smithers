import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { computeRunStateFromRow, deriveRunState } from "@smthrs/db/runState";
import { isWorkingCopyHoldingRunState } from "./isWorkingCopyHoldingRunState.js";
import { runConfigRootDir } from "./runConfigRootDir.js";

/** Non-terminal run statuses worth classifying. Mirrors what `ps` scans. */
const CANDIDATE_STATUSES = ["running", "paused", "waiting-approval", "waiting-event", "waiting-timer", "waiting-quota"];
const SCAN_LIMIT = 200;

/**
 * Resolve a path the way two independently launched runs must agree on, so
 * `/tmp/x` and `/private/tmp/x` compare equal. Falls back to the lexically
 * resolved path when the target cannot be stat'd.
 *
 * @param {string} path
 * @returns {string}
 */
function canonical(path) {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Runs that are still working in `cwd` right now.
 *
 * Oneshot executes the agent directly in `--cwd`, and its preflight treats
 * every dirty path as pre-existing work it may snapshot into a commit. When a
 * second run shares that directory, "pre-existing" is wrong: the diff belongs
 * to a run that is mid-flight. The workspace store already knows which runs
 * those are, so ask it.
 *
 * Liveness comes from `computeRunStateFromRow`, the same PID-verified
 * classifier `ps` and `inspect` use. A stale run classifies as `orphaned` when
 * its local owner PID is gone or its host-scoped owner is remote. It does not
 * count because the supervisor may recover it. Fully soft and read-only. A
 * store that cannot be read yields an empty list, because a preflight problem
 * must never block the goal.
 *
 * @param {any} adapter SmithersDb adapter (read-only)
 * @param {string} cwd the oneshot working directory
 * @param {{ excludeRunId?: string; nowMs?: number }} [options]
 * @returns {Promise<Array<{ runId: string; state: string; workflowName: string | null }>>}
 */
export async function findActiveRunsInCwd(adapter, cwd, options = {}) {
  const target = canonical(cwd);
  /** @type {Map<string, any>} */
  const candidates = new Map();
  for (const status of CANDIDATE_STATUSES) {
    let rows;
    try {
      rows = await adapter.listRuns(SCAN_LIMIT, status);
    } catch {
      // Soft: one failed status query must not hide the runs the others found.
      continue;
    }
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row.runId !== "string") continue;
      if (row.runId === options.excludeRunId) continue;
      if (candidates.has(row.runId)) continue;
      const rootDir = runConfigRootDir(row.configJson);
      if (rootDir === null || canonical(rootDir) !== target) continue;
      candidates.set(row.runId, row);
    }
  }
  const active = [];
  for (const row of candidates.values()) {
    const now = options.nowMs;
    let view;
    try {
      view = await computeRunStateFromRow(adapter, row, now != null ? { now } : {});
    } catch {
      try {
        view = deriveRunState({ run: row, ...(now != null ? { now } : {}) });
      } catch {
        continue;
      }
    }
    if (!isWorkingCopyHoldingRunState(view?.state)) continue;
    active.push({
      runId: row.runId,
      state: String(view.state),
      workflowName: typeof row.workflowName === "string" ? row.workflowName : null,
    });
  }
  active.sort((a, b) => a.runId.localeCompare(b.runId));
  return active;
}
