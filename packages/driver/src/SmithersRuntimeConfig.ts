export type SmithersRuntimeConfig = {
  cliAgentToolsDefault?: "all" | "explicit-only";
  baseRootDir?: string;
  workflowPath?: string | null;
  worktreePaths?: Record<string, string>;
  /** Name of the active RuntimeAdapter (e.g. "node", "browser"), used only for diagnostics. */
  runtimeName?: string;
  /**
   * Resolves a `<Worktree path>` prop the same way graph extraction does.
   * Sourced from `runtimeAdapter.worktree.resolve` by `WorkflowDriver`; when
   * absent, `SmithersCtx.resolveWorktreePath()` throws a typed
   * `RuntimeCapabilityError` instead of falling back to a Node-only import.
   */
  resolveWorktreePath?: (
    path: string,
    opts?: { baseRootDir?: string; workflowPath?: string | null },
  ) => string;
};
