import { dirname, isAbsolute, resolve } from "node:path";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { WORKTREE_EMPTY_PATH_ERROR } from "./constants.js";

/**
 * Resolve a <Worktree path> prop exactly the way graph extraction resolves it.
 * Relative paths are resolved against the launch root (`--root`, the nearest
 * `.smithers` anchor, or the operator cwd), never `dirname(workflowPath)`.
 * `workflowPath` is threaded through graph/engine rendering for workflow
 * identity and diagnostics only; it is not a worktree path resolution base.
 *
 * @param {unknown} path
 * @param {{ baseRootDir?: string; workflowPath?: string | null }} [opts]
 * @returns {string}
 */
export function resolveWorktreePath(path, opts) {
    const pathVal = String(path ?? "").trim();
    if (!pathVal) {
        throw new SmithersError("WORKTREE_EMPTY_PATH", WORKTREE_EMPTY_PATH_ERROR);
    }
    if (isAbsolute(pathVal)) {
        return resolve(pathVal);
    }
    const base = typeof opts?.baseRootDir === "string" && opts.baseRootDir.length > 0
        ? opts.baseRootDir
        : process.cwd();
    const resolvedPath = resolve(base, pathVal);
    warnRelativeWorktreePathOnce(pathVal, base, resolvedPath, opts?.workflowPath);
    return resolvedPath;
}

let didWarnRelativeWorktreePath = false;

/**
 * Reset process-local relative worktree warning state for deterministic tests.
 *
 * @returns {void}
 */
export function resetRelativeWorktreePathWarningForTest() {
    didWarnRelativeWorktreePath = false;
}

/**
 * @param {string} pathVal
 * @param {string} base
 * @param {string} resolvedPath
 * @param {string | null | undefined} workflowPath
 * @returns {void}
 */
function warnRelativeWorktreePathOnce(pathVal, base, resolvedPath, workflowPath) {
    if (didWarnRelativeWorktreePath) {
        return;
    }
    didWarnRelativeWorktreePath = true;
    const workflowDir = typeof workflowPath === "string" && workflowPath.length > 0
        ? dirname(workflowPath)
        : undefined;
    console.warn("relative <Worktree path> resolved against launch root, not the workflow file directory", {
        code: "WORKTREE_RELATIVE_PATH_BASE_ROOT",
        path: pathVal,
        base,
        resolvedPath,
        workflowPath,
        workflowDir,
    });
}
