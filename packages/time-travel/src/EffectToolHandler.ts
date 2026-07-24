import type { EffectBoundaryToolMetadata } from "./EffectBoundaryToolMetadata";

export type EffectToolHandler = EffectBoundaryToolMetadata & {
  revert?: (input: unknown, context: Record<string, unknown>) => Promise<void>;
};
