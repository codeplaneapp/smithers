import type { SmithersEvent } from "@smthrs/observability/SmithersEvent";

export type RetryTaskOptions = {
  runId: string;
  nodeId: string;
  iteration?: number;
  resetDependents?: boolean;
  force?: boolean;
  /**
   * Reset (and resume) a run whose driver is still demonstrably alive. Kept
   * separate from `force` so that forcing a retry past an active *status* never
   * silently steals a run from a live engine (`--steal-ownership`).
   */
  stealOwnership?: boolean;
  onProgress?: (event: SmithersEvent) => void;
};
