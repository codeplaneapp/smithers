import type { GatewayWebhookSignalConfig } from "./GatewayWebhookSignalConfig.js";
import type { GatewayWebhookRunConfig } from "./GatewayWebhookRunConfig.js";

export type GatewayWebhookConfig = {
  secret: string;
  /** Decode and durably deduplicate provider deliveries before signaling or launching. */
  source?: "github";
  signatureHeader?: string;
  signaturePrefix?: string;
  signal?: GatewayWebhookSignalConfig;
  run?: GatewayWebhookRunConfig;
};
