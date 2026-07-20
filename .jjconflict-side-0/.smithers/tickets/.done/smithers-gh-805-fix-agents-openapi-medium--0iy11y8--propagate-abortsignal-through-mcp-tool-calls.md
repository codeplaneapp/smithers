# Propagate abortSignal through MCP tool calls

GitHub: https://github.com/smithersai/smithers/issues/1025

Parent: smithers/gh-805-fix-agents-openapi-medium-network-backed-t-12gi34i.md

Context: generated MCP tools call client.callTool without the AI SDK execution signal, leaving cancelled MCP operations pending. Acceptance criteria: accept execution options in generated tool execute functions; pass the supplied abort signal through the MCP client call using the SDK-supported cancellation mechanism; ensure cancelled calls reject promptly and the underlying MCP request is cancelled; add a real-server cancellation test.


> Closed by ticket-fleet sync: Implemented in packages/agents/src/mcp/createMcpToolset.js:65-69, where generated AI SDK tools accept callOptions and forward callOptions.abortSignal; lines 119-127 pass it to client.callTool via the SDK-supported { signal } request option. The real-server cancellation test packages/agents/tests/mcp-toolset-cancellation.test.js:11-50 verifies prompt rejection and server-side cancellation through notifications/cancelled, using packages/agents/tests/fixtures/slow-mcp-server.js:21-31. The same test file also covers successful calls with a signal and already-aborted calls. Ran bun test --timeout=60000 --max-concurrency=1 tests/mcp-toolset-cancellation.test.js: 3 passed, 0 failed.
