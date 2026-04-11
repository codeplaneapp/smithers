import type { RunOptions } from "./RunOptions.ts";

export type CreateWorkflowSessionOptions = {
  db?: unknown;
  runId: string;
  rootDir?: string;
  workflowPath?: string | null;
  options: RunOptions;
};
