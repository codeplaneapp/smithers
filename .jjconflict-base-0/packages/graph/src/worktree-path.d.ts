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
declare function resolveWorktreePath(path: unknown, opts?: {
    baseRootDir?: string;
    workflowPath?: string | null;
}): string;
/**
 * Reset process-local relative worktree warning state for deterministic tests.
 *
 * @returns {void}
 */
declare function resetRelativeWorktreePathWarningForTest(): void;

export { resetRelativeWorktreePathWarningForTest, resolveWorktreePath };
