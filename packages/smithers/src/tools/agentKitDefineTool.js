/**
 * agent-kit variant of defineTool that accepts `inputSchema` (eve convention)
 * as an alias for `schema`.
 */
import { defineTool } from "./defineTool.js";

export function agentKitDefineTool(options) {
  const normalized = { ...options };
  if (options.inputSchema && !options.schema) {
    normalized.schema = options.inputSchema;
    delete normalized.inputSchema;
  }
  return defineTool(normalized);
}
