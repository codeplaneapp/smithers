import { ExternalEvent as ExternalEvent$1 } from '../core/ExternalEventTypes.js';
import { MakeGitHubWebhookSourceOptions as MakeGitHubWebhookSourceOptions$1 } from './GitHubWebhookSourceOptions.js';
import * as effect from 'effect';
import { WebhookRequest as WebhookRequest$1, MakeWebhookSourceOptions, WebhookSource } from '../core/EventSourceTypes.js';
import './GitHubConfig.js';
import '../core/CursorStoreTypes.js';
import '@smthrs/errors/SmithersError';

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
declare function decodeGitHubWebhook(request: WebhookRequest, receivedAtMs?: number): ExternalEvent[];
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
declare function makeGitHubWebhookSource(options?: MakeGitHubWebhookSourceOptions): effect.Effect.Effect<WebhookSource, never>;
/**
 * Config for `makeIntegrationRuntime({ webhookSources })`: same verification
 * and fan-out as {@link makeGitHubWebhookSource} but as a plain options
 * object (the runtime constructs the queue itself).
 *
 * @param {MakeGitHubWebhookSourceOptions} [options]
 * @returns {import("../core/EventSourceTypes.ts").MakeWebhookSourceOptions}
 */
declare function githubWebhookSourceConfig(options?: MakeGitHubWebhookSourceOptions): MakeWebhookSourceOptions;
/** @typedef {import("../core/EventSourceTypes.ts").WebhookRequest} WebhookRequest */
/** @typedef {import("../core/ExternalEventTypes.ts").ExternalEvent} ExternalEvent */
declare const GITHUB_SOURCE_ID: "github";
type MakeGitHubWebhookSourceOptions = MakeGitHubWebhookSourceOptions$1;
type WebhookRequest = WebhookRequest$1;
type ExternalEvent = ExternalEvent$1;

export { type ExternalEvent, GITHUB_SOURCE_ID, type MakeGitHubWebhookSourceOptions, type WebhookRequest, decodeGitHubWebhook, githubWebhookSourceConfig, makeGitHubWebhookSource };
