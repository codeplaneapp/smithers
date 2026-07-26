import type { EffectBoundaryAttempt } from "./EffectBoundaryAttempt";
import type { EffectBoundaryToolMetadata } from "./EffectBoundaryToolMetadata";

export type EffectBoundaryParams = {
  runId: string;
  cutoffMs?: number;
  attempts?: readonly EffectBoundaryAttempt[];
  toolMetadata?: ReadonlyMap<string, EffectBoundaryToolMetadata>;
};
