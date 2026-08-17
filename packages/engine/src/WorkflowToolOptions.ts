import type { WorkflowDefinition } from "@smthrs/driver/WorkflowDefinition";

export type WorkflowToolOptions<Schema = unknown> = {
  /** AI tool name. Letters, numbers, `_`, and `-` only. */
  name: string;
  workflow: WorkflowDefinition<Schema>;
  /** Defaults to the workflow description, then its readable name. */
  description?: string;
  /** Maximum workflow-tool ancestry depth, including this invocation. Default: 4. */
  maxDepth?: number;
  /** Maximum wall time for one child invocation. Default: 300000 (5 minutes). */
  timeoutMs?: number;
};
