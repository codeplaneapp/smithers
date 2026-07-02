/**
 * Parsed view of a `waiting-event` attempt's `meta_json` payload.
 *
 * The engine stamps `{ waitForEvent: { signalName, correlationId, ... } }`
 * onto the attempt when a `smithers:wait-for-event` node parks. This snapshot
 * is the single parsed shape shared by the engine's durable-deferred bridge
 * (`bridgeSignalResolve`) and the db adapter's `findRunsAwaitingEvent`.
 */
export type WaitForEventAttemptSnapshot = {
  /** The full parsed `meta_json` object (preserved for re-serialization). */
  meta: Record<string, unknown> & { waitForEvent?: unknown; kind?: unknown };
  /** The signal name the node is waiting on (trimmed, non-empty). */
  signalName: string;
  /** Normalized correlation id (trimmed; null when absent/blank). */
  correlationId: string | null;
  /** Whether the wait was entered in async (detached) mode. */
  waitAsync: boolean;
  /** Seq of the signal that resolved this wait, if already resolved. */
  resolvedSignalSeq: number | undefined;
  /** Timestamp (ms) the resolving signal was received, if resolved. */
  receivedAtMs: number | undefined;
};
