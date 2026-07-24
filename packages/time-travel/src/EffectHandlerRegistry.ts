import type { EffectBoundaryToolMetadata } from "./EffectBoundaryToolMetadata";
import type { EffectTaskHandler } from "./EffectTaskHandler";
import type { EffectToolHandler } from "./EffectToolHandler";

export type EffectHandlerRegistry = {
  toolMetadata: ReadonlyMap<string, EffectBoundaryToolMetadata>;
  tools: ReadonlyMap<string, EffectToolHandler>;
  tasks: ReadonlyMap<string, EffectTaskHandler>;
};
