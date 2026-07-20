/**
 * Options for shaping the generated toolset. Mirrors the curation knobs on
 * `createOpenApiTools` so MCP and OpenAPI integrations feel the same.
 */
export type McpToolsetOptions = {
  /** Only expose these MCP tool names. */
  include?: string[];
  /** Drop these MCP tool names. */
  exclude?: string[];
  /** Prefix applied to every tool name, e.g. `"github_"`. */
  namePrefix?: string;
  /** Identifies this client to the server. */
  clientName?: string;
  /** Client version reported to the server. */
  clientVersion?: string;
  /**
   * Sink for the MCP server's stderr. The transport pipes the child's stderr,
   * and if nothing reads it a chatty server deadlocks once the OS pipe buffer
   * fills, so it is always drained; by default each chunk is forwarded to the
   * host process stderr. Provide this to route it elsewhere (a logger, a
   * buffer, or a no-op to discard).
   */
  onStderr?: (chunk: string) => void;
};
