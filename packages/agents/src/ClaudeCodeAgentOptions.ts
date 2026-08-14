import type { BaseCliAgentOptions } from "./BaseCliAgent/BaseCliAgentOptions";

export type ClaudeCodeAgentOptions = BaseCliAgentOptions & {
  addDir?: string[];
  agent?: string;
  agents?: Record<string, { description?: string; prompt?: string }> | string;
  allowDangerouslySkipPermissions?: boolean;
  allowedTools?: string[];
  appendSystemPrompt?: string;
  /**
   * Path to an isolated Claude Code config directory. Sets `CLAUDE_CONFIG_DIR`
   * on the spawned process so this invocation uses that directory's
   * credentials (instead of the user's default `~/.claude/`): the CLI stores
   * them at `<configDir>/.credentials.json`, or on macOS in a per-config-dir
   * Keychain item suffixed with the first 8 hex chars of sha256(configDir).
   *
   * Use this to run multiple Claude Code subscriptions side-by-side. Set up
   * the directory by running `CLAUDE_CONFIG_DIR=<path> claude` once and
   * completing `/login` interactively, or via
   * `smithers agents add --provider claude-code --label <name> --tmux`.
   */
  configDir?: string;
  /**
   * Anthropic API key for billing this invocation against the API instead of
   * a Claude Pro/Max subscription. When set, ClaudeCodeAgent stops unsetting
   * `ANTHROPIC_API_KEY` (which it normally clears so subscription auth wins).
   */
  apiKey?: string;
  betas?: string[];
  chrome?: boolean;
  continue?: boolean;
  dangerouslySkipPermissions?: boolean;
  debug?: boolean | string;
  debugFile?: string;
  disableSlashCommands?: boolean;
  disallowedTools?: string[];
  fallbackModel?: string;
  file?: string[];
  forkSession?: boolean;
  fromPr?: string;
  ide?: boolean;
  includePartialMessages?: boolean;
  inputFormat?: "text" | "stream-json";
  jsonSchema?: string;
  maxBudgetUsd?: number;
  mcpConfig?: string[];
  mcpDebug?: boolean;
  model?: string;
  noChrome?: boolean;
  noSessionPersistence?: boolean;
  outputFormat?: "text" | "json" | "stream-json";
  // `effort` is inherited from BaseCliAgentOptions (the shared first-class
  // reasoning-effort surface). Claude Code translates it in buildCommand by
  // merging `{ effortLevel }` into a single `--settings` flag — user-supplied
  // `--settings` (extraArgs or opts.settings) keys win on conflict.
  permissionMode?: "acceptEdits" | "bypassPermissions" | "default" | "delegate" | "dontAsk" | "plan";
  pluginDir?: string[];
  replayUserMessages?: boolean;
  resume?: string;
  sessionId?: string;
  settingSources?: string;
  settings?: string;
  strictMcpConfig?: boolean;
  systemPrompt?: string;
  tools?: string[] | "default" | "";
  verbose?: boolean;
};
