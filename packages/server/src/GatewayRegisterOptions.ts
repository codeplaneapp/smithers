import type { GatewayWebhookConfig } from "./GatewayWebhookConfig.js";
import type { GatewayUiConfig } from "./GatewayUiConfig.js";

export type GatewayRegisterOptions = {
  schedule?: string;
  webhook?: GatewayWebhookConfig;
  ui?: GatewayUiConfig;
  /** Internal plumbing workflow (e.g. init): excluded from default `listWorkflows` results unless the caller opts in via `filter.includeSystem`. */
  system?: boolean;
};
