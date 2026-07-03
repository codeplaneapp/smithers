import { C as CursorStore$1, E as ExternalEvent$1, a as EventSource$2, M as MakePollingSourceOptions$1, b as MakeWebhookSourceOptions$1, P as PollResult$1, W as WebhookRequest$1, c as WebhookSource$1 } from './EventSourceTypes-BAOYWyD3.js';
import * as _smithers_orchestrator_db_adapter from '@smithers-orchestrator/db/adapter';
import * as _smithers_orchestrator_errors_SmithersError from '@smithers-orchestrator/errors/SmithersError';
import { SmithersError } from '@smithers-orchestrator/errors/SmithersError';
import { Effect, Schema } from 'effect';
import * as effect_Effect from 'effect/Effect';
import * as effect_ParseResult from 'effect/ParseResult';
import * as effect_SchemaAST from 'effect/SchemaAST';

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/**
 * CursorStore backed by the db adapter's `_smithers_integration_cursors`
 * table, so a polling source survives process restarts.
 * @param {SmithersDb} adapter
 * @returns {CursorStore}
 */
declare function makeDbCursorStore(adapter: SmithersDb$1): CursorStore;
/**
 * In-memory CursorStore (tests / ephemeral sources).
 * @returns {CursorStore}
 */
declare function makeInMemoryCursorStore(): CursorStore;
type SmithersDb$1 = _smithers_orchestrator_db_adapter.SmithersDb;
type CursorStore = CursorStore$1;

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
declare function deliverEvents(adapter: SmithersDb, source: EventSource$1): Effect.Effect<void, _smithers_orchestrator_errors_SmithersError.SmithersError>;
type SmithersDb = _smithers_orchestrator_db_adapter.SmithersDb;
type ExternalEvent = ExternalEvent$1;
type EventSource$1 = EventSource$2;

/**
 * Build a Queue-backed webhook EventSource. Ingress code calls
 * `offer(request)` per incoming HTTP request: the request is verified
 * (`invalid-signature` failure on mismatch), decoded into ExternalEvents, and
 * enqueued; the returned `source.events` stream feeds the delivery pipeline.
 *
 * @param {MakeWebhookSourceOptions} options
 * @returns {Effect.Effect<WebhookSource, never>}
 */
declare function makeWebhookSource(options: MakeWebhookSourceOptions): Effect.Effect<WebhookSource, never>;
/**
 * Build a polling EventSource: repeatedly runs `poll(cursor)` on `schedule`
 * (first poll immediately), persists the returned cursor through the
 * CursorStore, and emits the polled events one by one.
 *
 * @param {MakePollingSourceOptions} options
 * @returns {EventSource}
 */
declare function makePollingSource(options: MakePollingSourceOptions): EventSource;
type EventSource = EventSource$2;
type MakePollingSourceOptions = MakePollingSourceOptions$1;
type MakeWebhookSourceOptions = MakeWebhookSourceOptions$1;
type PollResult = PollResult$1;
type WebhookRequest = WebhookRequest$1;
type WebhookSource = WebhookSource$1;

/**
 * Runtime schema for {@link ExternalEvent}. Webhook sources decode incoming
 * requests through this schema so malformed decoder output fails loudly at
 * the ingress boundary instead of surfacing as a broken signal later.
 */
declare const ExternalEventSchema: Schema.Struct<{
    source: typeof Schema.String;
    eventName: typeof Schema.String;
    correlationId: Schema.NullOr<typeof Schema.String>;
    payload: typeof Schema.Unknown;
    dedupeKey: typeof Schema.String;
    receivedAtMs: typeof Schema.Number;
}>;
declare const decodeExternalEvent: (u: unknown, overrideOptions?: effect_SchemaAST.ParseOptions) => effect_Effect.Effect<{
    readonly source: string;
    readonly eventName: string;
    readonly correlationId: string | null;
    readonly payload: unknown;
    readonly dedupeKey: string;
    readonly receivedAtMs: number;
}, effect_ParseResult.ParseError, never>;

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
type MakeIntegrationRuntimeOptions$1 = {
    adapter: _smithers_orchestrator_db_adapter.SmithersDb;
    sources?: EventSource$2[];
    webhookSources?: MakeWebhookSourceOptions$1[];
};
/**
 * A running integration runtime: one supervised delivery fiber per source,
 * a promise-based webhook entrypoint for the node HTTP server, and a
 * graceful shutdown.
 */
type IntegrationRuntime$1 = {
    /** True when a webhook source with this id is registered. */
    hasWebhookSource: (sourceId: string) => boolean;
    /**
     * Verify + enqueue a webhook delivery. Rejects with an IntegrationError
     * whose `reason` is `unknown-source` (404), `invalid-signature` (401), or
     * `decode-failed` (400).
     */
    handleWebhook: (sourceId: string, request: WebhookRequest$1) => Promise<{
        accepted: number;
    }>;
    /** Interrupt all source fibers and dispose the runtime. Idempotent. */
    shutdown: () => Promise<void>;
};

/**
 * Start the process-wide integration runtime: forks one supervised delivery
 * fiber per event source (webhook + polling) and exposes a promise-based
 * `handleWebhook` seam for the node HTTP server, plus a graceful `shutdown`.
 * Fibers run on a dedicated ManagedRuntime so shutdown cannot leak them.
 *
 * @param {MakeIntegrationRuntimeOptions} options
 * @returns {IntegrationRuntime}
 */
declare function makeIntegrationRuntime(options: MakeIntegrationRuntimeOptions): IntegrationRuntime;
type IntegrationRuntime = IntegrationRuntime$1;
type MakeIntegrationRuntimeOptions = MakeIntegrationRuntimeOptions$1;

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

export { type CursorStore, ExternalEventSchema, INTEGRATION_SIGNAL_PREFIX, IntegrationError, type IntegrationErrorReason, type IntegrationRuntime, type MakeIntegrationRuntimeOptions, type MakePollingSourceOptions, type MakeWebhookSourceOptions, type PollResult, type WebhookRequest, type WebhookSource, computeHmacSha256Hex, decodeExternalEvent, deliverEvent, deliverEvents, integrationEventName, integrationReceivedBy, isIntegrationError, isIntegrationSignalName, makeDbCursorStore, makeInMemoryCursorStore, makeIntegrationRuntime, makePollingSource, makeWebhookSource, parseIntegrationEventName, readJsonPath, verifySignature };
