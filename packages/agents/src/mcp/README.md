# mcp/

`createMcpToolset.js` — connect to an MCP server over stdio and project its
tools as AI SDK `dynamicTool`s (the inbound half of MCP-as-integration), plus
type sidecars (`McpServerConfig.ts`, `McpToolset.ts`, `McpToolsetOptions.ts`).

Lifecycle: spawns the server via `StdioClientTransport`, lists tools once,
filters via include/exclude, and prefixes tool names. `close()` MUST be called
to terminate the server process.

stderr contract: the child's stderr is piped and must be continuously drained
or a chatty server deadlocks (~64-80KB OS pipe buffer); `options.onStderr`
routes chunks somewhere other than the host `process.stderr`. Known issue: the
drain is currently attached twice, so sinks see each chunk twice.

Tool results reduce to `structuredContent` when present, else joined text;
`isError` becomes `{ error, message, status }`.

Exported via the package's `./mcp/createMcpToolset` entry.
