/**
 * How a stale run can be relaunched: the run was started from a `.tsx`
 * file, so `smithers up <file> --resume` re-enters it.
 */
export type ResumeTarget = { kind: "workflow-file"; workflowPath: string; cwd: string };
