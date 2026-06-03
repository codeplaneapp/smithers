import type { BaseCliAgentOptions } from "./BaseCliAgent/BaseCliAgentOptions";

export type AntigravityAgentOptions = BaseCliAgentOptions & {
  model?: string;
  sandbox?: boolean;
  yolo?: boolean;
  dangerouslySkipPermissions?: boolean;
  allowedMcpServerNames?: string[];
  allowedTools?: string[];
  /**
   * Conversation id to resume. Forwarded as `--conversation=<id>` (the
   * Antigravity CLI also accepts the short `-c` form). There is no `--resume`
   * flag, and listing/switching conversations is the in-session `/resume`
   * command rather than a launch flag.
   */
  resume?: string;
  /**
   * Extra workspace directories to grant the agent. Forwarded as repeated
   * `--add-dir` flags (the CLI has no `--include-directories`).
   */
  includeDirectories?: string[];
  /**
   * Parse mode for the CLI's print output. The Antigravity CLI has no
   * `--output-format` flag, so this only selects how Smithers interprets
   * stdout — it is not forwarded as a CLI argument.
   */
  outputFormat?: "text" | "json" | "stream-json";
  /**
   * Antigravity CLI binary to execute. The official CLI currently installs
   * `agy`; this exists for test harnesses and future binary renames.
   */
  binary?: string;
  /**
   * Path to an isolated Google CLI config root. Passed as `--gemini_dir` so
   * Antigravity reads/writes `<configDir>/antigravity-cli/...` instead of the
   * user's default `~/.gemini/antigravity-cli/...`.
   */
  configDir?: string;
  /**
   * Explicit alias for `configDir` when matching the Antigravity CLI flag name.
   */
  geminiDir?: string;
  /**
   * Google API key for API-billed invocations when supported by the CLI.
   */
  apiKey?: string;
};
