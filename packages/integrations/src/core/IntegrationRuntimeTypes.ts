import type { EventSource, MakeWebhookSourceOptions, WebhookRequest } from "./EventSourceTypes.ts";

/**
 * Options for `makeIntegrationRuntime`. `sources` are self-driving streams
 * (e.g. polling sources); `webhookSources` are webhook source configs the
 * runtime constructs internally so `handleWebhook(sourceId, request)` can
 * route incoming HTTP deliveries to them.
 */
export type MakeIntegrationRuntimeOptions = {
  adapter: import("@smthrs/db/adapter").SmithersDb;
  sources?: EventSource[];
  webhookSources?: MakeWebhookSourceOptions[];
};

/**
 * A running integration runtime: one supervised delivery fiber per source,
 * a promise-based webhook entrypoint for the node HTTP server, and a
 * graceful shutdown.
 */
export type IntegrationRuntime = {
  /** True when a webhook source with this id is registered. */
  hasWebhookSource: (sourceId: string) => boolean;
  /**
   * Verify + enqueue a webhook delivery. Rejects with an IntegrationError
   * whose `reason` is `unknown-source` (404), `invalid-signature` (401), or
   * `decode-failed` (400).
   */
  handleWebhook: (sourceId: string, request: WebhookRequest) => Promise<{ accepted: number }>;
  /**
   * Reject new ingress, drain accepted webhooks, stop other source fibers,
   * and dispose the runtime. Concurrent calls share one promise.
   */
  shutdown: () => Promise<void>;
};
