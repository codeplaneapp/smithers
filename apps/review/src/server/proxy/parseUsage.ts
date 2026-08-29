/**
 * Token-count + model summary the metering side records per upstream call.
 */
export interface UsageSummary {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}
