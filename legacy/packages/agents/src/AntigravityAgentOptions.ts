import type { BaseCliAgentOptions } from "./BaseCliAgent/BaseCliAgentOptions";

export type AntigravityAgentOptions = BaseCliAgentOptions & {
  model?: string;
  sandbox?: boolean;
  yolo?: boolean;
  dangerouslySkipPermissions?: boolean;
  allowedMcpServerNames?: string[];
  allowedTools?: string[];
  /**
   * @deprecated Antigravity renamed extensions to plugins and manages them via
   * `agy plugin`; launch-time extension flags are rejected at runtime.
   */
  extensions?: string[];
  /**
   * @deprecated Use `agy plugin list` outside Smithers. This option is rejected
   * at runtime because current `agy` builds no longer accept it during launch.
   */
  listExtensions?: boolean;
  /**
   * Native Antigravity conversation id. Smithers emits `--conversation`.
   */
  conversation?: string;
  /**
   * Continue the latest Antigravity conversation. Smithers emits `--continue`.
   */
  continue?: boolean;
  /**
   * @deprecated Use `conversation`; Smithers still maps this to
   * `--conversation` for compatibility.
   */
  resume?: string;
  /**
   * @deprecated Conversation listing is interactive via `/resume`; this option
   * is rejected at runtime.
   */
  listSessions?: boolean;
  /**
   * @deprecated Conversation deletion is not a supported non-interactive
   * launch flag; this option is rejected at runtime.
   */
  deleteSession?: string;
  includeDirectories?: string[];
  /**
   * @deprecated Current `agy` builds do not expose `--screen-reader`; this
   * option is rejected at runtime.
   */
  screenReader?: boolean;
  /**
   * @deprecated Current `agy` builds do not expose `--output-format`; Smithers
   * reads Antigravity stdout as text.
   */
  outputFormat?: "text" | "json" | "stream-json";
  /**
   * @deprecated Current `agy` builds do not expose `--debug`; this option is
   * rejected at runtime.
   */
  debug?: boolean;
  /**
   * Antigravity CLI binary to execute. The official CLI currently installs
   * `agy`; this exists for test harnesses and future binary renames.
   */
  binary?: string;
  /**
   * Path to an isolated Google CLI config root. Smithers passes it as
   * `--gemini_dir` and `GEMINI_DIR` so Antigravity reads/writes
   * `<configDir>/antigravity-cli/...` instead of the user's default
   * `~/.gemini/antigravity-cli/...`.
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
