export type EffectBoundaryToolMetadata = {
  name: string;
  sideEffect: boolean;
  idempotent: boolean;
  hasRevert?: boolean;
};
