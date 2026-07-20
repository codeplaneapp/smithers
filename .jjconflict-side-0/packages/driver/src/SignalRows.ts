/**
 * Raw signal row as loaded by a `RuntimeAdapter.signals.load` implementation
 * (or seeded via `RunOptions.signals` for tests/replay without a live
 * adapter). Mirrors `@smithers-orchestrator/db`'s `SignalRow` shape minus
 * `runId` (the ctx is already run-scoped). `payloadJson` may be a JSON string
 * (as stored durably) or an already-parsed value (test convenience).
 */
export type SignalRowInput = {
  seq: number;
  signalName: string;
  correlationId: string | null;
  payloadJson: string | unknown;
  receivedAtMs: number;
  receivedBy?: string | null;
};

/**
 * A signal row as handed to workflow/render code. `payload` is intentionally
 * `unknown` — signals are not schema-validated at receipt time (a `smithers
 * signal` call can deliver arbitrary JSON), so typed access belongs to the
 * caller (e.g. `@smithers-orchestrator/xstate`'s `eventReceived`, which
 * validates against a supplied schema and reports a typed error naming the
 * signal on failure) rather than being asserted here.
 */
export type SignalRow = {
  payload: unknown;
  signalName: string;
  correlationId: string | null;
  seq: number;
  receivedAtMs: number;
};

export type SignalRowsOptions = {
  /** Only rows delivered with this exact correlation id (or `null` for uncorrelated rows). */
  correlationId?: string | null;
};

export type SignalRowsReader = (signalName: string, options?: SignalRowsOptions) => SignalRow[];
