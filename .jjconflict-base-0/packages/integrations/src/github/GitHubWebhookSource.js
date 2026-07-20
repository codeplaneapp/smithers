// @smithers-type-exports-begin
/** @typedef {import("./GitHubWebhookSourceOptions.ts").MakeGitHubWebhookSourceOptions} MakeGitHubWebhookSourceOptions */
// @smithers-type-exports-end

import { IntegrationError } from "../core/IntegrationError.js";
import { makeWebhookSource } from "../core/EventSource.js";
import { integrationEventName } from "../core/signalNames.js";
import { verifySignature } from "../core/verifySignature.js";
import { resolveGitHubConfig } from "./config.js";

/** @typedef {import("../core/EventSourceTypes.ts").WebhookRequest} WebhookRequest */
/** @typedef {import("../core/ExternalEventTypes.ts").ExternalEvent} ExternalEvent */

export const GITHUB_SOURCE_ID = "github";

/**
 * @param {WebhookRequest} request
 * @param {string} name
 * @returns {string | undefined}
 */
function header(request, name) {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
}

/**
 * Pull the entity number out of a GitHub webhook payload: PRs, issues and
 * issue comments carry it in different places.
 * @param {any} payload
 * @returns {number | null}
 */
function extractNumber(payload) {
    const candidates = [
        payload?.pull_request?.number,
        payload?.issue?.number,
        payload?.number,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === "number" && Number.isInteger(candidate)) {
            return candidate;
        }
    }
    return null;
}

/**
 * Decode one GitHub webhook delivery into ExternalEvents.
 *
 * A single delivery fans out into one event per (name, correlation) variant
 * so a listener parked on ANY of the forms wakes — `findRunsAwaitingEvent`
 * matches signal name + correlationId exactly, so each variant must exist as
 * its own signal:
 * - names: base (`integration:github:pull_request`) and, when the payload has
 *   an `action`, the per-action variant (`integration:github:pull_request.opened`);
 * - correlations: `<owner>/<repo>#<number>` (when the payload carries a
 *   number), `<owner>/<repo>`, and `null` (repo-agnostic listeners).
 *
 * dedupeKeys embed the variant (`<deliveryId>:<name>:<correlation>`) so a
 * webhook REdelivery dedupes per variant while one delivery's own variants
 * never collide with each other.
 *
 * @param {WebhookRequest} request
 * @param {number} [receivedAtMs]
 * @returns {ExternalEvent[]}
 */
export function decodeGitHubWebhook(request, receivedAtMs = Date.now()) {
    const event = header(request, "x-github-event");
    if (!event) {
        throw new IntegrationError("decode-failed", "GitHub webhook is missing the X-GitHub-Event header.", { sourceId: GITHUB_SOURCE_ID });
    }
    const deliveryId = header(request, "x-github-delivery");
    if (!deliveryId) {
        throw new IntegrationError("decode-failed", "GitHub webhook is missing the X-GitHub-Delivery header.", { sourceId: GITHUB_SOURCE_ID, event });
    }
    /** @type {any} */
    const payload = JSON.parse(request.rawBody);
    const action = typeof payload?.action === "string" && payload.action.length > 0
        ? payload.action
        : null;
    const repo = typeof payload?.repository?.full_name === "string" &&
        payload.repository.full_name.includes("/")
        ? payload.repository.full_name
        : null;
    const number = extractNumber(payload);
    const names = [integrationEventName("github", event)];
    if (action) {
        names.push(integrationEventName("github", `${event}.${action}`));
    }
    /** @type {(string | null)[]} */
    const correlations = [];
    if (repo && number !== null) {
        correlations.push(`${repo}#${number}`);
    }
    if (repo) {
        correlations.push(repo);
    }
    correlations.push(null);
    /** @type {ExternalEvent[]} */
    const events = [];
    for (const eventName of names) {
        for (const correlationId of correlations) {
            events.push({
                source: GITHUB_SOURCE_ID,
                eventName,
                correlationId,
                payload,
                dedupeKey: `${deliveryId}:${eventName}:${correlationId ?? "*"}`,
                receivedAtMs,
            });
        }
    }
    return events;
}

/**
 * GitHub webhook EventSource: verifies `X-Hub-Signature-256` (HMAC-SHA256,
 * `sha256=` prefix) against the resolved webhook secret and fans each
 * delivery out per {@link decodeGitHubWebhook}. Plug the result into
 * `makeIntegrationRuntime({ webhookSources: [...] })` — or build it yourself
 * and pass `source`/`offer` around.
 *
 * @param {MakeGitHubWebhookSourceOptions} [options]
 * @returns {import("effect").Effect.Effect<import("../core/EventSourceTypes.ts").WebhookSource, never>}
 */
export function makeGitHubWebhookSource(options = {}) {
    return makeWebhookSource(githubWebhookSourceConfig(options));
}

/**
 * Config for `makeIntegrationRuntime({ webhookSources })`: same verification
 * and fan-out as {@link makeGitHubWebhookSource} but as a plain options
 * object (the runtime constructs the queue itself).
 *
 * @param {MakeGitHubWebhookSourceOptions} [options]
 * @returns {import("../core/EventSourceTypes.ts").MakeWebhookSourceOptions}
 */
export function githubWebhookSourceConfig(options = {}) {
    const { id = GITHUB_SOURCE_ID, capacity, ...config } = options;
    const resolved = resolveGitHubConfig(config);
    if (!resolved.webhookSecret) {
        throw new IntegrationError("invalid-signature", "GitHub webhook source requires a webhookSecret (option, configureGitHub, or SMITHERS_GITHUB_WEBHOOK_SECRET).", { sourceId: id });
    }
    const secret = resolved.webhookSecret;
    return {
        id,
        capacity,
        verify: (request) => verifySignature({
            payload: request.rawBody,
            secret,
            signature: header(request, "x-hub-signature-256"),
            prefix: "sha256=",
        }),
        decode: (request) => decodeGitHubWebhook(request),
    };
}
