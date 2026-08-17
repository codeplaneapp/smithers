import type { BaseCliAgentOptions } from "./BaseCliAgent/BaseCliAgentOptions";

export type GrokAgentOptions = BaseCliAgentOptions & {
  /** Isolated Grok Build configuration root. Sets `GROK_HOME`. */
  configDir?: string;
  /** xAI API key passed only through `XAI_API_KEY`. */
  apiKey?: string;
  tools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  sandbox?: string;
  rules?: string;
  noPlan?: boolean;
  noSubagents?: boolean;
  noMemory?: boolean;
  disableWebSearch?: boolean;
};
