import type { BaseCliAgentOptions } from "./BaseCliAgent/BaseCliAgentOptions";

export type VibeAgentOptions = BaseCliAgentOptions & {
  agent?: string;
  maxTurns?: number;
  maxPrice?: number;
  maxTokens?: number;
  enabledTools?: string[];
  sessionId?: string;
  continueSession?: boolean;
};
