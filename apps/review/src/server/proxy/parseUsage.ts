/**
 * Token-count + model summary the metering side records per upstream call.
 */
export interface UsageSummary {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Provider-reported tier, retained to detect a standard_only contract breach. */
  serviceTier?: string;
  /** Provider-reported inference geography, retained for billing-policy audits. */
  inferenceGeo?: string;
}
