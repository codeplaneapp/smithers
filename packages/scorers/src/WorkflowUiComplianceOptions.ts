/** Options for `gradeWorkflowUiSource`. */
export type WorkflowUiComplianceOptions = {
  /**
   * Force the live-chat rule on/off. When omitted it is derived from
   * `workflowSource` (agent tasks present → required), defaulting to off.
   */
  requireNodeChat?: boolean;
  /** The workflow module's source, used to detect agent tasks. */
  workflowSource?: string;
};

/** One broken rule occurrence. */
export type WorkflowUiViolation = {
  rule:
    | "imports"
    | "shell"
    | "mount"
    | "live-chat"
    | "hand-rolled-colors"
    | "hand-rolled-pills"
    | "hand-rolled-table";
  detail: string;
};

/** The grader's result. */
export type WorkflowUiComplianceReport = {
  passed: boolean;
  /** 1 minus the fraction of distinct rules broken. */
  score: number;
  violations: WorkflowUiViolation[];
};
