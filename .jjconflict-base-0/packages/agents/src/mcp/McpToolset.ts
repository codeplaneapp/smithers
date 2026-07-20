import type { Tool } from "ai";

/**
 * A live connection to an MCP server, with its tools projected as AI SDK tools.
 *
 * `tools` is shaped exactly like the record returned by `createOpenApiTools`, so it
 * drops straight into an SDK agent's `tools`. The connection (and the spawned server
 * process) stays open until `close()` is called.
 */
export type McpToolset = {
  /** AI SDK tools keyed by (prefixed) MCP tool name. */
  tools: Record<string, Tool>;
  /** Names present in `tools`, after include/exclude/prefix are applied. */
  toolNames: string[];
  /** Disconnect the client and terminate the spawned server process. */
  close: () => Promise<void>;
};
