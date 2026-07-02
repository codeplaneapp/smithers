import type { MakeWebhookSourceOptions } from "../core/EventSource.ts";
import type { LinearConfig } from "./LinearConfig.ts";

export type MakeLinearWebhookSourceOptions = LinearConfig & {
  /** Source id (and `/v1/webhooks/:sourceId` segment). @default "linear" */
  id?: string;
  /** Bounded ingress queue capacity. @default 256 */
  capacity?: number;
  /**
   * Max age of `webhookTimestamp` before a delivery is rejected as stale
   * (replay protection, per Linear's docs). @default 60_000
   */
  maxTimestampSkewMs?: number;
};

/** The webhook-source options object (plugs into core `makeWebhookSource` or `makeIntegrationRuntime({ webhookSources })`). */
export type LinearWebhookSourceConfig = MakeWebhookSourceOptions;
