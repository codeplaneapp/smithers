import type { BranchInfo } from "./BranchInfo";
import type { Snapshot } from "./snapshot/Snapshot";
import type { EffectBoundaryReport } from "./EffectBoundaryReport";

export type ReplayResult = {
  runId: string;
  branch: BranchInfo;
  snapshot: Snapshot;
  vcsRestored: boolean;
  vcsPointer: string | null;
  vcsError?: string;
  effectBoundary: EffectBoundaryReport;
};
