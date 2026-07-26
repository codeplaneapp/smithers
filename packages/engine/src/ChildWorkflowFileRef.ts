/**
 * Reference to a workflow module file produced at runtime (for example by an
 * architect agent that authors a workflow mid-run). The file must default
 * export a workflow built with `smithers(...)` and must live inside the
 * approved root — paths that resolve (including through symlinks) outside the
 * root are rejected before anything is imported.
 *
 * Structurally identical to the `WorkflowFileRef` accepted by the `<Subflow>`
 * component in `@smithers-orchestrator/components`.
 */
export type ChildWorkflowFileRef = {
  /**
   * Path to the workflow module. Relative paths resolve against the approved
   * root.
   */
  path: string;
  /**
   * Directory the workflow file must stay within. Defaults to the parent
   * run's `rootDir`.
   */
  approvedRoot?: string;
};
