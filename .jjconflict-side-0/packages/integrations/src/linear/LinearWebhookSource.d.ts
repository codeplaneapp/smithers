import { LinearWebhookSourceConfig as LinearWebhookSourceConfig$1, MakeLinearWebhookSourceOptions as MakeLinearWebhookSourceOptions$1 } from './LinearWebhookSourceTypes.js';
import { ExternalEvent } from '../core/ExternalEventTypes.js';
import { WebhookRequest } from '../core/EventSourceTypes.js';
import './LinearConfig.js';
import '../core/CursorStoreTypes.js';
import 'effect';
import '@smithers-orchestrator/errors/SmithersError';

/**
 * Verify a Linear webhook request: `Linear-Signature` is the HMAC-SHA256
 * hex digest of the raw body, and `webhookTimestamp` inside the body must
 * be fresh (within `maxTimestampSkewMs`) to block replays.
 *
 * @param {import("../core/EventSourceTypes.ts").WebhookRequest} request
 * @param {string} secret
 * @param {number} [maxTimestampSkewMs]
 * @param {() => number} [now]
 * @returns {boolean}
 */
declare function verifyLinearWebhook(request: WebhookRequest, secret: string, maxTimestampSkewMs?: number, now?: () => number): boolean;
/**
 * Decode a Linear webhook delivery into ExternalEvents.
 *
 * Linear payload shape: `{ action: "create"|"update"|"remove", type:
 * "Issue"|"Comment"|..., data, updatedFrom?, url, webhookId,
 * webhookTimestamp, organizationId }`.
 *
 * Per delivery this emits, for both the action-specific name
 * (`integration:linear:issue.update`) and the base name
 * (`integration:linear:issue`), one event per correlation variant: the
 * issue identifier (`ENG-123`), the team key (`ENG`), and `null` (catch-all
 * listeners). `findRunsAwaitingEvent` matches (eventName, correlationId)
 * pairs exactly, so each variant is required for its listener shape; each
 * gets a distinct dedupeKey suffix so redeliveries of the whole webhook
 * dedupe while sibling variants do not collide.
 *
 * @param {import("../core/EventSourceTypes.ts").WebhookRequest} request
 * @param {string} sourceId
 * @returns {import("../core/ExternalEventTypes.ts").ExternalEvent[]}
 */
declare function decodeLinearWebhook(request: WebhookRequest, sourceId?: string): ExternalEvent[];
/**
 * Build the Linear webhook source config (core `MakeWebhookSourceOptions`):
 * pass it to `makeIntegrationRuntime({ webhookSources: [...] })` or feed it
 * to `makeWebhookSource` directly. Verifies `Linear-Signature`
 * (HMAC-SHA256 hex of the raw body) plus `webhookTimestamp` freshness, and
 * decodes deliveries into `integration:linear:<type>.<action>` /
 * `integration:linear:<type>` events.
 *
 * @param {MakeLinearWebhookSourceOptions} [options]
 * @returns {LinearWebhookSourceConfig}
 */
declare function makeLinearWebhookSource(options?: MakeLinearWebhookSourceOptions): LinearWebhookSourceConfig;
/** Default Linear webhook source id. */
declare const LINEAR_SOURCE_ID: "linear";
/** Reject webhook deliveries whose `webhookTimestamp` is older than this. */
declare const DEFAULT_LINEAR_TIMESTAMP_SKEW_MS: 60000;
type LinearWebhookSourceConfig = LinearWebhookSourceConfig$1;
type MakeLinearWebhookSourceOptions = MakeLinearWebhookSourceOptions$1;

export { DEFAULT_LINEAR_TIMESTAMP_SKEW_MS, LINEAR_SOURCE_ID, type LinearWebhookSourceConfig, type MakeLinearWebhookSourceOptions, decodeLinearWebhook, makeLinearWebhookSource, verifyLinearWebhook };
