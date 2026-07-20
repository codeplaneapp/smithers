/**
 * How to launch an MCP server over stdio. Swap `command`/`args` to point at any
 * MCP server (the demo fixture, GitHub's `@modelcontextprotocol/server-github`,
 * Linear's MCP server, etc.) and its tools become agent-callable.
 */
export type McpServerConfig = {
  /** Executable to spawn, e.g. `"bun"`, `"npx"`, `"node"`. */
  command: string;
  /** Arguments passed to the executable. */
  args?: string[];
  /**
   * Environment for the spawned process. When omitted, the MCP SDK passes a
   * minimal safe environment. Include any secrets the server needs here
   * (e.g. `GITHUB_PERSONAL_ACCESS_TOKEN`).
   */
  env?: Record<string, string>;
  /** Working directory for the spawned process. */
  cwd?: string;
};
