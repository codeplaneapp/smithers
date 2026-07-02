import * as effect from 'effect';
import { Effect, Stream } from 'effect';
import * as _smithers_orchestrator_errors_SmithersError from '@smithers-orchestrator/errors/SmithersError';
import { SmithersError } from '@smithers-orchestrator/errors/SmithersError';
import * as _smithers_orchestrator_db_adapter from '@smithers-orchestrator/db/adapter';

/**
 * Durable persistence seam for polling-source cursors. The db-backed
 * implementation (`makeDbCursorStore`) rides `_smithers_integration_cursors`.
 */
type CursorStore = {
    get: (sourceId: string) => Effect.Effect<string | null | undefined, SmithersError>;
    set: (sourceId: string, cursor: string | null) => Effect.Effect<void, SmithersError>;
};

/**
 * A normalized event received from an external service (webhook delivery or
 * polling result) before it is fanned out to waiting runs via `signalRun`.
 */
type ExternalEvent$1 = {
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

/**
 * A process-wide source of external events. `events` is the (possibly
 * infinite) stream the IntegrationRuntime drains into the delivery pipeline.
 */
type EventSource$1 = {
    id: string;
    events: Stream.Stream<ExternalEvent$1, SmithersError>;
};
/**
 * The raw webhook request handed to a webhook source's `offer`: the
 * already-read raw body (needed for HMAC verification) plus headers.
 */
type WebhookRequest = {
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
};
type MakeWebhookSourceOptions = {
    id: string;
    /** Bounded queue capacity between ingress and delivery. @default 256 */
    capacity?: number;
    /** Signature check; return false to reject with `invalid-signature`. */
    verify?: (request: WebhookRequest) => boolean;
    /** Decode a verified request into one or more ExternalEvents. */
    decode: (request: WebhookRequest) => ExternalEvent$1 | ExternalEvent$1[];
};
type WebhookSource = {
    source: EventSource$1;
    /** Verify + decode + enqueue a webhook request; resolves with the accepted count. */
    offer: (request: WebhookRequest) => effect.Effect.Effect<{
        accepted: number;
    }, SmithersError>;
    shutdown: effect.Effect.Effect<void>;
};
type PollResult = {
    events: ExternalEvent$1[];
    /** Next cursor to persist; omit/undefined to keep the current cursor. */
    cursor?: string | null;
};
type MakePollingSourceOptions = {
    id: string;
    /** One poll turn: given the current cursor, fetch new events + next cursor. */
    poll: (cursor: string | null) => effect.Effect.Effect<PollResult, SmithersError>;
    /** Poll cadence. @default Schedule.spaced("5 seconds") */
    schedule?: effect.Schedule.Schedule<unknown>;
    /** Durable cursor persistence (e.g. `makeDbCursorStore(adapter)`). */
    cursorStore?: CursorStore;
};

/**
 * Deliver ONE external event: dedupe against
 * `_smithers_integration_deliveries`, find runs parked on
 * `WaitForEvent(eventName, correlationId)`, and `signalRun` each with
 * `receivedBy: "integration:<source>"`. Per-run failures are retried then
 * logged — they never fail the returned effect, so the source stream lives on.
 *
 * @param {SmithersDb} adapter
 * @param {ExternalEvent} event
 * @returns {Effect.Effect<{ deduped: boolean; runIds: string[] }, import("@smithers-orchestrator/errors/SmithersError").SmithersError>}
 */
declare function deliverEvent(adapter: SmithersDb, event: ExternalEvent): Effect.Effect<{
    deduped: boolean;
    runIds: string[];
}, _smithers_orchestrator_errors_SmithersError.SmithersError>;
/**
 * Drain an EventSource into the delivery pipeline. Per-event delivery errors
 * are logged and swallowed so a single bad event never kills the stream; a
 * stream-level error (e.g. a failing poll) surfaces to the caller, which is
 * expected to retry/restart (see IntegrationRuntime's supervision).
 *
 * @param {SmithersDb} adapter
 * @param {EventSource} source
 * @returns {Effect.Effect<void, import("@smithers-orchestrator/errors/SmithersError").SmithersError>}
 */
declare function deliverEvents(adapter: SmithersDb, source: EventSource): Effect.Effect<void, _smithers_orchestrator_errors_SmithersError.SmithersError>;
type SmithersDb = _smithers_orchestrator_db_adapter.SmithersDb;
type ExternalEvent = ExternalEvent$1;
type EventSource = EventSource$1;

/**
 * @param {unknown} error
 * @returns {error is IntegrationError}
 */
declare function isIntegrationError(error: unknown): error is IntegrationError;
/**
 * @typedef {"invalid-signature" | "unknown-source" | "decode-failed" | "poll-failed" | "delivery-failed" | "queue-closed"} IntegrationErrorReason
 */
/**
 * Error raised by integration event sources and the delivery pipeline.
 * A `SmithersError` (code `INTEGRATION_ERROR`) with a machine-readable
 * `reason` so ingress code can map failures to HTTP statuses
 * (`invalid-signature` → 401, `unknown-source` → 404, ...).
 */
declare class IntegrationError extends SmithersError {
    /**
   * @param {IntegrationErrorReason} reason
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   * @param {{ cause?: unknown }} [options]
   */
    constructor(reason: IntegrationErrorReason, message: string, details?: Record<string, unknown>, options?: {
        cause?: unknown;
    });
    /** @type {IntegrationErrorReason} */
    reason: IntegrationErrorReason;
}
type IntegrationErrorReason = "invalid-signature" | "unknown-source" | "decode-failed" | "poll-failed" | "delivery-failed" | "queue-closed";

/**
 * Options for `makeIntegrationRuntime`. `sources` are self-driving streams
 * (e.g. polling sources); `webhookSources` are webhook source configs the
 * runtime constructs internally so `handleWebhook(sourceId, request)` can
 * route incoming HTTP deliveries to them.
 */
type MakeIntegrationRuntimeOptions = {
    adapter: _smithers_orchestrator_db_adapter.SmithersDb;
    sources?: EventSource$1[];
    webhookSources?: MakeWebhookSourceOptions[];
};
/**
 * A running integration runtime: one supervised delivery fiber per source,
 * a promise-based webhook entrypoint for the node HTTP server, and a
 * graceful shutdown.
 */
type IntegrationRuntime = {
    /** True when a webhook source with this id is registered. */
    hasWebhookSource: (sourceId: string) => boolean;
    /**
     * Verify + enqueue a webhook delivery. Rejects with an IntegrationError
     * whose `reason` is `unknown-source` (404), `invalid-signature` (401), or
     * `decode-failed` (400).
     */
    handleWebhook: (sourceId: string, request: WebhookRequest) => Promise<{
        accepted: number;
    }>;
    /** Interrupt all source fibers and dispose the runtime. Idempotent. */
    shutdown: () => Promise<void>;
};

/**
 * Read a dot-separated path (e.g. `"issue.id"`) out of a decoded JSON value.
 * Returns `undefined` when any segment is missing or the value is not an
 * object along the way. An empty/undefined path returns the value itself.
 * @param {unknown} value
 * @param {string | undefined} [path]
 * @returns {unknown}
 */
declare function readJsonPath(value: unknown, path?: string | undefined): unknown;

/**
 * Build the signal name for an integration event:
 * `integration:<service>:<event>` (e.g. `integration:github:pull_request.opened`,
 * `integration:telegram:message`). The `event` segment may contain dots for
 * per-action variants but neither segment may contain `:`.
 * @param {string} service
 * @param {string} event
 * @returns {string}
 */
declare function integrationEventName(service: string, event: string): string;
/**
 * Predicate for the reserved `integration:` signal-name prefix.
 * @param {unknown} signalName
 * @returns {boolean}
 */
declare function isIntegrationSignalName(signalName: unknown): boolean;
/**
 * Parse an `integration:<service>:<event>` signal name back into its parts.
 * Returns `null` for non-integration names.
 * @param {string} signalName
 * @returns {{ service: string; event: string } | null}
 */
declare function parseIntegrationEventName(signalName: string): {
    service: string;
    event: string;
} | null;
/**
 * The `receivedBy` attribution stamped on signals delivered by an
 * integration source: `integration:<service>`.
 * @param {string} service
 * @returns {string}
 */
declare function integrationReceivedBy(service: string): string;
/**
 * Reserved prefix for integration-delivered signals. User signals must not
 * use it; every event delivered by an integration source does.
 */
declare const INTEGRATION_SIGNAL_PREFIX: "integration:";

/**
 * Compute the lowercase hex HMAC-SHA256 of `payload` with `secret`.
 * @param {string | Uint8Array} payload
 * @param {string} secret
 * @returns {string}
 */
declare function computeHmacSha256Hex(payload: string | Uint8Array, secret: string): string;
/**
 * Verify an HMAC-SHA256 webhook signature in constant time.
 *
 * Accepts the GitHub style (`sha256=<hex>` in `X-Hub-Signature-256`; pass
 * `prefix: "sha256="` or rely on the default prefix stripping) as well as
 * plain hex or base64 digests (Linear's `Linear-Signature` is plain hex).
 *
 * @param {{
 *   payload: string | Uint8Array;
 *   secret: string;
 *   signature: string | null | undefined;
 *   prefix?: string;
 * }} options
 * @returns {boolean} true only when the signature matches.
 */
declare function verifySignature(options: {
    payload: string | Uint8Array;
    secret: string;
    signature: string | null | undefined;
    prefix?: string;
}): boolean;

export { type CursorStore, INTEGRATION_SIGNAL_PREFIX, IntegrationError, type IntegrationErrorReason, type IntegrationRuntime, type MakeIntegrationRuntimeOptions, type MakePollingSourceOptions, type MakeWebhookSourceOptions, type PollResult, type SmithersDb, type WebhookRequest, type WebhookSource, computeHmacSha256Hex, deliverEvent, deliverEvents, integrationEventName, integrationReceivedBy, isIntegrationError, isIntegrationSignalName, parseIntegrationEventName, readJsonPath, verifySignature };
