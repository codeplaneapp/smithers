import type { BaseCliAgentOptions } from "./BaseCliAgent";

/**
 * Configuration options for the OpenCodeAgent.
 */
export type OpenCodeAgentOptions = BaseCliAgentOptions & {
  /** Model identifier (e.g., "anthropic/claude-opus-4-8", "openai/gpt-5.5") */
  model?: string;
  /** OpenCode agent name (maps to --agent flag, selects predefined agent config) */
  agentName?: string;
  /** Files to attach to the prompt via -f flags */
  attachFiles?: string[];
  /** Continue a previous session */
  continueSession?: boolean;
  /** Resume a specific session by ID */
  sessionId?: string;
  /** Provider-specific model variant/reasoning effort level */
  variant?: string;
};
