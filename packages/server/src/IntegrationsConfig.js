/**
 * A generic HMAC-verified webhook event source served at
 * `POST /v1/webhooks/:id`. Each verified delivery becomes ONE external event
 * (signal name = `event`) fanned out to runs parked on
 * `WaitForEvent(event, correlationId)` via the integration runtime.
 *
 * @typedef {object} IntegrationsWebhookSourceConfig
 * @property {string} id Source id, the `:sourceId` path segment of `POST /v1/webhooks/:sourceId`.
 * @property {string} secret HMAC-SHA256 shared secret used to verify deliveries.
 * @property {string} [signatureHeader] Header carrying the signature. Defaults to `x-hub-signature-256`.
 * @property {string} [signaturePrefix] Required signature prefix (e.g. GitHub's `sha256=`). When
 *   omitted, a leading `sha256=` is stripped if present and plain hex/base64 digests are accepted.
 * @property {string} event Signal name to deliver (e.g. `integration:test:ping`).
 * @property {string} [correlationIdPath] Dot-path into the JSON payload for the correlation id (e.g. `issue.key`).
 * @property {string} [payloadPath] Dot-path selecting the signal payload. Defaults to the whole body.
 * @property {string} [dedupeKeyPath] Dot-path for a provider-stable delivery id used for redelivery
 *   dedupe. Defaults to `sha256(rawBody)`.
 * @property {number} [capacity] Bounded ingress queue capacity. Defaults to 256.
 */

/**
 * Server-level integrations config (`ServerOptions.integrations`). Requires
 * `ServerOptions.db`: delivered events are deduped and matched against the
 * server database.
 *
 * @typedef {object} IntegrationsConfig
 * @property {IntegrationsWebhookSourceConfig[]} [webhooks]
 */

export {};
