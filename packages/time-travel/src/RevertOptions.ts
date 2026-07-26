import type { SmithersEvent } from "@smithers-orchestrator/observability/SmithersEvent";

export type RevertOptions = {
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  force?: boolean;
  noRevert?: boolean;
  caller?: string;
  onProgress?: (event: SmithersEvent) => void;
  hooks?: {
    afterEffectReverts?: () => Promise<void> | void;
  };
};
