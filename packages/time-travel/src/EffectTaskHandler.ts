export type EffectTaskHandler = {
  revert?: (context: Record<string, unknown>) => Promise<void>;
};
