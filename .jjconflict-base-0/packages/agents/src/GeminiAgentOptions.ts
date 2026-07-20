import type { BaseCliAgentOptions } from "./BaseCliAgent/BaseCliAgentOptions";

/**
 * @deprecated Gemini CLI support has been sunset. Use AntigravityAgentOptions
 * with the Antigravity CLI (`agy`) for Google CLI integrations.
 */
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
   * Legacy option retained only so old constructor calls type-check.
   */
  configDir?: string;
  /**
   * Legacy option retained only so old constructor calls type-check.
   */
  apiKey?: string;
};
