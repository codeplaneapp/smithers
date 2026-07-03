// @smithers-type-exports-begin
/** @typedef {import("./LinearWebhookSourceTypes.ts").LinearWebhookSourceConfig} LinearWebhookSourceConfig */
/** @typedef {import("./LinearWebhookSourceTypes.ts").MakeLinearWebhookSourceOptions} MakeLinearWebhookSourceOptions */
// @smithers-type-exports-end

import { integrationEventName } from "../core/signalNames.js";
import { verifySignature } from "../core/verifySignature.js";
import { resolveLinearConfig } from "./config.js";

/** Default Linear webhook source id. */
export const LINEAR_SOURCE_ID = "linear";

/** Reject webhook deliveries whose `webhookTimestamp` is older than this. */
export const DEFAULT_LINEAR_TIMESTAMP_SKEW_MS = 60_000;

/**
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {string} name
 * @returns {string | undefined}
 */
function headerValue(headers, name) {
    const value = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
}

/**
 * Linear's `webhookTimestamp` is a unix timestamp in milliseconds; tolerate
 * second-precision values from older payloads.
 * @param {unknown} value
 * @returns {number | null}
 */
function normalizeWebhookTimestampMs(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return null;
    }
    return value < 1e12 ? value * 1000 : value;
}

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
export function verifyLinearWebhook(request, secret, maxTimestampSkewMs = DEFAULT_LINEAR_TIMESTAMP_SKEW_MS, now = Date.now) {
    const signature = headerValue(request.headers, "linear-signature");
    if (!verifySignature({ payload: request.rawBody, secret, signature })) {
        return false;
    }
    /** @type {any} */
    let payload;
    try {
        payload = JSON.parse(request.rawBody);
    }
    catch {
        return false;
    }
    const timestampMs = normalizeWebhookTimestampMs(payload?.webhookTimestamp);
    if (timestampMs === null) {
        return false;
    }
    return Math.abs(now() - timestampMs) <= maxTimestampSkewMs;
}

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
export function decodeLinearWebhook(request, sourceId = LINEAR_SOURCE_ID) {
    /** @type {any} */
    const payload = JSON.parse(request.rawBody);
    const type = typeof payload?.type === "string" ? payload.type : "unknown";
    const action = typeof payload?.action === "string" ? payload.action : "unknown";
    const data = payload?.data ?? {};
    const typeSegment = type.toLowerCase();
    const receivedAtMs = Date.now();
    // Delivery identity: prefer the Linear-Delivery header (unique per
    // delivery); fall back to webhookId + entity id + action + timestamp.
    const deliveryId = headerValue(request.headers, "linear-delivery") ??
        [payload?.webhookId ?? "-", typeSegment, action, data?.id ?? "-", payload?.webhookTimestamp ?? "-"].join(":");
    const identifier = typeof data?.identifier === "string" && data.identifier
        ? data.identifier
        : typeof data?.issue?.identifier === "string" && data.issue.identifier
            ? data.issue.identifier
            : null;
    const teamKey = typeof data?.team?.key === "string" && data.team.key
        ? data.team.key
        : typeof data?.issue?.team?.key === "string" && data.issue.team.key
            ? data.issue.team.key
            : null;
    const eventNames = [
        integrationEventName(LINEAR_SOURCE_ID, `${typeSegment}.${action.toLowerCase()}`),
        integrationEventName(LINEAR_SOURCE_ID, typeSegment),
    ];
    /** @type {(string | null)[]} */
    const correlations = [...new Set([identifier, teamKey].filter((value) => value !== null)), null];
    /** @type {import("../core/ExternalEventTypes.ts").ExternalEvent[]} */
    const events = [];
    for (const eventName of eventNames) {
        for (const correlationId of correlations) {
            events.push({
                source: sourceId,
                eventName,
                correlationId,
                payload,
                dedupeKey: `${deliveryId}#${eventName}#${correlationId ?? ""}`,
                receivedAtMs,
            });
        }
    }
    return events;
}

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
export function makeLinearWebhookSource(options = {}) {
    const { id = LINEAR_SOURCE_ID, capacity, maxTimestampSkewMs = DEFAULT_LINEAR_TIMESTAMP_SKEW_MS, ...config } = options;
    const secret = resolveLinearConfig(config).webhookSecret;
    return {
        id,
        ...(capacity !== undefined ? { capacity } : {}),
        verify: (request) => {
            if (!secret) {
                return false;
            }
            return verifyLinearWebhook(request, secret, maxTimestampSkewMs);
        },
        decode: (request) => decodeLinearWebhook(request, id),
    };
}
