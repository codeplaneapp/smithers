/**
 * Optional, self-reported provenance for the process that started a run.
 * This is distinct from authenticated `RunAuthContext` identity.
 */
export type RunStartedBy = {
  harness?: string;
  sessionId?: string;
  prompt?: string;
  /** Present only when environment detection supplied an identity field. */
  detected?: true;
};
