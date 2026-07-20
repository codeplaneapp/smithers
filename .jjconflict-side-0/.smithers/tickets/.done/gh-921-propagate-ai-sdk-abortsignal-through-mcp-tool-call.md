# Propagate AI SDK abortSignal through MCP tool calls

GitHub: https://github.com/smithersai/smithers/issues/921

Accept ToolExecutionOptions in generated MCP tools and propagate abortSignal through the MCP client request/transport boundary. Add a real MCP cancellation test that aborts a pending tools/call operation and verifies prompt rejection.


> Closed by ticket-fleet sync: Implemented in packages/agents/src/mcp/createMcpToolset.js:65-69 and 119-127; generated tools accept callOptions and forward abortSignal as the MCP Client.callTool request signal. Real cancellation coverage is in packages/agents/tests/mcp-toolset-cancellation.test.js using packages/agents/tests/fixtures/slow-mcp-server.js; it verifies prompt rejection, server-side cancellation, normal completion, and pre-aborted behavior. Tests passed: mcp-toolset-cancellation.test.js (3 pass) and mcp-toolset.test.js (5 pass).
