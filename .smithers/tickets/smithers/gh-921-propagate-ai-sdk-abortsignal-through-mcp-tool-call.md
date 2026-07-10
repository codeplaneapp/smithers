# Propagate AI SDK abortSignal through MCP tool calls

GitHub: https://github.com/smithersai/smithers/issues/921

Accept ToolExecutionOptions in generated MCP tools and propagate abortSignal through the MCP client request/transport boundary. Add a real MCP cancellation test that aborts a pending tools/call operation and verifies prompt rejection.
