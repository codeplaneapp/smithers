import type { BaseCliAgentOptions } from "./BaseCliAgent";

/**
 * Configuration options for the OpenCodeAgent.
 */
export type OpenCodeAgentOptions = BaseCliAgentOptions & {
  /** Model identifier (e.g., "anthropic/claude-opus-4-8", "openai/gpt-5.6-luna") */
  model?: string;
  /** OpenCode agent name (maps to --agent flag, selects predefined agent config) */
  agentName?: string;
  /** Files to attach to the prompt via -f flags */
  attachFiles?: string[];
  /** Continue a previous session */
  continueSession?: boolean;
  /** Resume a specific session by ID */
  sessionId?: string;
  /**
   * Provider-specific model variant/reasoning-effort level (OpenCode `--variant`).
   *
   * OpenCode has no fixed effort ladder: the shared {@link BaseCliAgentOptions.effort}
   * option maps onto this provider-defined string when `variant` is unset (an
   * explicit `variant` always wins). Providers that expose no variant knob
   * treat `effort` as unsupported.
   */
  variant?: string;
};
