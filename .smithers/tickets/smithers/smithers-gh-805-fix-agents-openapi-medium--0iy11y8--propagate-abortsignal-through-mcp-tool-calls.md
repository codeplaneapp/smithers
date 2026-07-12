# Propagate abortSignal through MCP tool calls

GitHub: https://github.com/smithersai/smithers/issues/1025

Parent: smithers/gh-805-fix-agents-openapi-medium-network-backed-t-12gi34i.md

Context: generated MCP tools call client.callTool without the AI SDK execution signal, leaving cancelled MCP operations pending. Acceptance criteria: accept execution options in generated tool execute functions; pass the supplied abort signal through the MCP client call using the SDK-supported cancellation mechanism; ensure cancelled calls reject promptly and the underlying MCP request is cancelled; add a real-server cancellation test.
