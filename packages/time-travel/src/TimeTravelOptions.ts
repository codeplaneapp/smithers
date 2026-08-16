import type { SmithersEvent } from "@smthrs/observability/SmithersEvent";

export type TimeTravelOptions = {
  runId: string;
  nodeId: string;
  iteration?: number;
  attempt?: number;
  resetDependents?: boolean;
  restoreVcs?: boolean;
  force?: boolean;
  /**
   * Proceed even though the run still has a demonstrably live driver. Separate
   * from `force` on purpose: `force` crosses effect boundaries, this one takes
   * ownership away from a running engine (`--steal-ownership`).
   */
  stealOwnership?: boolean;
  noRevert?: boolean;
  caller?: string;
  onProgress?: (event: SmithersEvent) => void;
  hooks?: {
    afterEffectReverts?: () => Promise<void> | void;
  };
};
