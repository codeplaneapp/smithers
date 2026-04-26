import type { BaseCliAgentOptions } from "./BaseCliAgent/BaseCliAgentOptions";

export type GeminiAgentOptions = BaseCliAgentOptions & {
  debug?: boolean;
  model?: string;
  sandbox?: boolean;
  yolo?: boolean;
  approvalMode?: "default" | "auto_edit" | "yolo" | "plan";
  experimentalAcp?: boolean;
  allowedMcpServerNames?: string[];
  allowedTools?: string[];
  extensions?: string[];
  listExtensions?: boolean;
  resume?: string;
  listSessions?: boolean;
  deleteSession?: string;
  includeDirectories?: string[];
  screenReader?: boolean;
  outputFormat?: "text" | "json" | "stream-json";
  /**
   * Path to an isolated Gemini CLI config directory. Sets `GEMINI_DIR` on the
   * spawned process so this invocation uses the credentials stored at
   * `<configDir>/oauth_creds.json` (instead of the user's default
   * `~/.gemini/`). Use this to run multiple Gemini accounts side-by-side.
   */
  configDir?: string;
  /**
   * Gemini API key. Sets `GEMINI_API_KEY` on the spawned process for
   * API-billed invocations.
   */
  apiKey?: string;
};
