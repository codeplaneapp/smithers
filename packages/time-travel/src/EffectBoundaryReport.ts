import type { CrossedEffect } from "./CrossedEffect.ts";

export type EffectBoundaryReport = {
  blocking: CrossedEffect[];
  revertible: CrossedEffect[];
  warnings: CrossedEffect[];
};
