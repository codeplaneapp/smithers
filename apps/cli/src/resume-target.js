// @smithers-type-exports-begin
/** @typedef {import("./ResumeTarget.ts").ResumeTarget} ResumeTarget */
// @smithers-type-exports-end

import { dirname, isAbsolute, resolve } from "node:path";

/**
 * Resolving "how do I restart this run?".
 *
 * Every recovery tool (`supervise`, `hijack`, the give-up diagnostics) answers
 * that question with `run.workflow_path`. This module turns a run row into one
 * {@link ResumeTarget} the resume path can spawn; keep it the single source of
 * truth for how a recorded workflow path becomes a relaunch.
 */

/**
 * Absolute form of a recorded workflow path, or null when none was recorded.
 *
 * @param {string | null | undefined} workflowPath
 * @param {string} [from]
 * @returns {string | null}
 */
export function resolveWorkflowPath(workflowPath, from = process.cwd()) {
  if (!workflowPath) return null;
  return isAbsolute(workflowPath) ? workflowPath : resolve(from, workflowPath);
}

/**
 * Resolve how to relaunch a run: the workflow file on disk is the authored
 * source of truth, so a run whose file is missing is not resumable.
 *
 * @param {{ runId?: string; workflowPath?: string | null; configJson?: unknown }} run
 * @param {{ workflowExists: (workflowPath: string) => boolean; cwd?: string }} deps
 * @returns {ResumeTarget | null}
 */
export function resolveResumeTarget(run, deps) {
  const from = deps.cwd ?? process.cwd();
  const workflowPath = resolveWorkflowPath(run.workflowPath, from);
  if (workflowPath && deps.workflowExists(workflowPath)) {
    return { kind: "workflow-file", workflowPath, cwd: dirname(workflowPath) };
  }
  return null;
}

/**
 * Human-readable identity of a resume target, for logs and give-up diagnostics.
 *
 * @param {ResumeTarget} target
 * @returns {string}
 */
export function describeResumeTarget(target) {
  return target.workflowPath;
}
