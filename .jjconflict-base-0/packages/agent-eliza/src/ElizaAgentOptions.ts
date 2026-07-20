/**
 * Minimal structural types for elizaOS so this file compiles even when
 * @elizaos/core is not installed. We use `import type` only, so there is no
 * runtime dependency.
 */

/** Minimal elizaOS Character shape — structural, not imported from core. */
export type ElizaCharacter = {
  name: string;
  bio?: string | string[];
  lore?: string[];
  messageExamples?: unknown[];
  postExamples?: string[];
  topics?: string[];
  adjectives?: string[];
  knowledge?: string[];
  clients?: string[];
  plugins?: string[];
  settings?: Record<string, unknown>;
  system?: string;
  [key: string]: unknown;
};

/** Minimal elizaOS Plugin shape — structural, not imported from core. */
export type ElizaPlugin = {
  name: string;
  description?: string;
  actions?: unknown[];
  providers?: unknown[];
  evaluators?: unknown[];
  services?: unknown[];
  [key: string]: unknown;
};

/**
 * Options for {@link ElizaAgent}.
 *
 * Wraps the elizaOS `AgentRuntime` in-process, forwarding plugins/settings
 * so callers can use any elizaOS plugin (Slack, Discord, Telegram, etc.)
 * as a Smithers agent backend.
 */
export type ElizaAgentOptions = {
  /**
   * The elizaOS Character definition for this agent.
   * Passed directly to `AgentRuntime` — any elizaOS-compatible character
   * object is accepted.
   */
  character: ElizaCharacter;
  /**
   * elizaOS plugins to register on the runtime (Services, Actions,
   * Providers, Evaluators). This is how callers bolt on Slack/Discord/etc.
   */
  plugins?: ElizaPlugin[];
  /**
   * Key-value settings forwarded to the runtime (e.g. `SLACK_BOT_TOKEN`).
   * Merged with the character's existing `settings` record.
   */
  settings?: Record<string, string>;
  /**
   * Additional environment variables forwarded to the runtime alongside
   * `settings`. Merged in when constructing the runtime.
   */
  env?: Record<string, string>;
  /**
   * Optional model label used in result diagnostics and the `modelId` field
   * of `buildGenerateResult`. Defaults to `"eliza"`.
   */
  model?: string;
  /**
   * Alias for `model` — either may be used; `model` takes precedence.
   */
  modelId?: string;
  /**
   * Optional unique identifier for this agent instance.
   */
  id?: string;
};
