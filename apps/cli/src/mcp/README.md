# apps/cli/src/mcp

The `smithers --mcp` server surface.

- `mcp-mode.js` — entry point. `runMcpModeIfRequested` detects `--mcp` in argv,
  picks a surface via `parseMcpSurfaceArgv` (the raw CLI-command surface, the
  semantic surface, or both), and wires up a `StdioServerTransport`.
  `registerRawToolsOnMcpServer` mirrors every incur-defined CLI command as a
  raw tool.
- `semantic-server.js` — builds the `McpServer` and validates/scopes tool
  registration: rejects unknown or duplicate tool names, applies the
  `allowedTools` allowlist and the `readOnly` filter (keeps only tools with
  `annotations.readOnlyHint === true`).
- `semantic-tools.js` — defines the 21 semantic tools (`SEMANTIC_TOOL_NAMES`)
  with zod input/output schemas and handlers that open the workspace DB
  directly via `findAndOpenDb` — no gateway in the path. Every handler funnels
  through `executeSemanticTool` → `toolSuccess`/`toolFailure`, so results are
  always the `{ ok, data?, error? }` envelope (also serialized into the text
  content block); errors are normalized with `toSmithersError`.

The `Semantic*.ts` files (`SemanticToolName`, `SemanticToolDefinition`,
`SemanticToolCallResult`, `SemanticToolError`, `SemanticToolContext`,
`SemanticMcpServerOptions`) are type-only sidecars consumed through JSDoc
typedef imports; keep them in lockstep with the runtime shapes in the `.js`
files.

Gotcha: `SEMANTIC_TOOL_NAMES` must stay a plain array literal —
`apps/cli/tests/docs-public-surface-coverage.test.js` regex-extracts it and
asserts every tool has a `### <name>` section in
`docs/integrations/mcp-server.mdx`; `SemanticToolName.ts` mirrors the same
list.
