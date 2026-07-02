import type { GatewayWebhookConfig } from "./GatewayWebhookConfig.js";
import type { GatewayUiConfig } from "./GatewayUiConfig.js";

export type GatewayRegisterOptions = {
  schedule?: string;
  webhook?: GatewayWebhookConfig;
  ui?: GatewayUiConfig;
  /** Internal plumbing workflow (e.g. init): excluded from default `listWorkflows` results unless the caller opts in via `filter.includeSystem`. */
  system?: boolean;
  /**
   * Absolute path of the workflow source file this entry was loaded from.
   * Threaded into `runWorkflow` as `workflowPath` so gateway-hosted runs record
   * real durability metadata (entry/module-graph hashes) — and, critically, so
   * the gateway can RESUME a parked run started elsewhere (e.g. a detached CLI
   * run paused at an approval gate): without a path the resume computes no
   * hashes and the engine rejects it with RESUME_METADATA_MISMATCH.
   */
  entryFile?: string;
};
