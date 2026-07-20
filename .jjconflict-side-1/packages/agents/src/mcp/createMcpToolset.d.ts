import type { McpServerConfig } from "./McpServerConfig.js";
import type { McpToolset } from "./McpToolset.js";
import type { McpToolsetOptions } from "./McpToolsetOptions.js";

export type { McpServerConfig } from "./McpServerConfig.js";
export type { McpToolset } from "./McpToolset.js";
export type { McpToolsetOptions } from "./McpToolsetOptions.js";

export declare function createMcpToolset(
  config: McpServerConfig,
  options?: McpToolsetOptions,
): Promise<McpToolset>;
