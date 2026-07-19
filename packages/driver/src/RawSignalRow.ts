/**
 * The raw `_smithers_signals` row shape a `RuntimeAdapter`/`WorkflowDriver`
 * carries into `SmithersCtx` for a render — mirrors
 * `@smithers-orchestrator/db`'s `SignalRow` (camelCase) without importing the
 * db package, so this portable driver core stays free of sqlite/postgres
 * modules (see `stripAutoColumns` in SmithersCtx.js for the same rationale).
 */
export type RawSignalRow = {
  seq: number;
  signalName: string;
  correlationId?: string | null;
  payloadJson: string;
  receivedAtMs: number;
};
