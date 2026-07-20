/**
 * A structured error surfaced through the data client's `onError` channel so a
 * broken SSE stream is observable instead of reconnecting silently. A
 * `disconnected` error fires once per reconnect attempt, carrying the backoff
 * about to elapse and the underlying cause when the transport captured one. A
 * `malformed_frame` error fires when a stream frame fails to parse.
 */
export type SmithersStreamError =
  | {
      reason: "disconnected";
      /** Zero-based index of the reconnect attempt about to run. */
      reconnectAttempt: number;
      /** Delay before that reconnect attempt, in milliseconds. */
      backoffMs: number;
      /** Underlying transport failure, when one was captured. */
      cause?: unknown;
    }
  | {
      reason: "malformed_frame";
      /** The SSE event whose payload failed to parse. */
      event: "change" | "reset" | "heartbeat";
      /** The parse error. */
      cause: unknown;
    };
