import type { EffectBoundaryReport } from "./EffectBoundaryReport.ts";

export type RevertResult = {
  success: boolean;
  error?: string;
  jjPointer?: string;
  effectBoundary: EffectBoundaryReport;
};
