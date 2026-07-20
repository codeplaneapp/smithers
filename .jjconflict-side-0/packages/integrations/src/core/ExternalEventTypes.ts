/**
 * A normalized event received from an external service (webhook delivery or
 * polling result) before it is fanned out to waiting runs via `signalRun`.
 */
export type ExternalEvent = {
  /** Source id that produced the event (e.g. `github`, `telegram`, a generic webhook source id). */
  source: string;
  /** Smithers signal name, `integration:<service>:<event>` by convention. */
  eventName: string;
  /** Correlation id used to target waiting runs (null = match waits without one). */
  correlationId: string | null;
  /** JSON-serializable payload delivered as the signal payload. */
  payload: unknown;
  /** Provider-stable delivery id used for redelivery dedupe. */
  dedupeKey: string;
  /** When the event was received (Unix epoch ms). */
  receivedAtMs: number;
};
