export type NodeDetailTokenUsage = {
  inputTokens: number;
  freshInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  eventCount: number;
  models: string[];
  agents: string[];
};
