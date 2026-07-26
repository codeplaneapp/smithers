import type { SmithersEvent } from "@smithers-orchestrator/observability/SmithersEvent";

export type TimeTravelOptions = {
  runId: string;
  nodeId: string;
  iteration?: number;
  attempt?: number;
  resetDependents?: boolean;
  restoreVcs?: boolean;
  force?: boolean;
  noRevert?: boolean;
  caller?: string;
  onProgress?: (event: SmithersEvent) => void;
  hooks?: {
    afterEffectReverts?: () => Promise<void> | void;
  };
};
