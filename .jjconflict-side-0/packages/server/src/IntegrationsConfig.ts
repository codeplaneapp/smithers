/**
 * A generic HMAC-verified webhook event source served at
 * `POST /v1/webhooks/:id`. Each verified delivery becomes ONE external event
 * (signal name = `event`) fanned out to runs parked on
 * `WaitForEvent(event, correlationId)` via the integration runtime.
 */
export type IntegrationsWebhookSourceConfig = {
  /** Source id — the `:sourceId` path segment of `POST /v1/webhooks/:sourceId`. */
  id: string;
  /** HMAC-SHA256 shared secret used to verify deliveries. */
  secret: string;
  /**
   * Header carrying the signature.
   * @default "x-hub-signature-256"
   */
  signatureHeader?: string;
  /**
   * Required signature prefix (e.g. GitHub's `sha256=`). When omitted, a
   * leading `sha256=` is stripped if present and plain hex/base64 digests
   * are accepted.
   */
  signaturePrefix?: string;
  /** Signal name to deliver (e.g. `integration:test:ping`). */
  event: string;
  /** Dot-path into the JSON payload for the correlation id (e.g. `issue.key`). */
  correlationIdPath?: string;
  /** Dot-path selecting the signal payload; defaults to the whole body. */
  payloadPath?: string;
  /**
   * Dot-path for a provider-stable delivery id used for redelivery dedupe;
   * defaults to `sha256(rawBody)`.
   */
  dedupeKeyPath?: string;
  /** Bounded ingress queue capacity. @default 256 */
  capacity?: number;
};

/**
 * Server-level integrations config (`ServerOptions.integrations`). Requires
 * `ServerOptions.db` — delivered events are deduped and matched against the
 * server database.
 */
export type IntegrationsConfig = {
  webhooks?: IntegrationsWebhookSourceConfig[];
};
