import type { SmithersEvent } from "@smthrs/observability/SmithersEvent";

export type RetryTaskOptions = {
  runId: string;
  nodeId: string;
  iteration?: number;
  resetDependents?: boolean;
  force?: boolean;
  onProgress?: (event: SmithersEvent) => void;
};
