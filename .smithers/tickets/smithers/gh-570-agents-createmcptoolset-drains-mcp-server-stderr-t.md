# 🐛 agents: createMcpToolset drains MCP server stderr twice — every chunk hits the sink twice

GitHub: https://github.com/smithersai/smithers/issues/570

**What happens**
`packages/agents/src/mcp/createMcpToolset.js:30` calls `drainStderr(transport, options.onStderr)` (defined at :90-102, attaches a 'data' listener forwarding each chunk to the sink). Lines 43-56 then attach a second, near-identical 'data' listener on the same `transport.stderr` PassThrough with the same sink resolution.

**Why it's wrong / failure scenario**
Node delivers each 'data' event to all listeners: a user-supplied `onStderr` callback fires twice per chunk, and by default the server's stderr is written to host `process.stderr` twice (duplicated log lines). The flood test in `tests/mcp-toolset.test.js` only asserts `received >= flood`, so the doubling passes unnoticed.

**Expected behavior**
Exactly one drain path. The inline block at :43-56 looks like the pre-extraction original that should have been removed when `drainStderr` was added — note it is the only one with a `stream.on("error")` handler, so the fix must keep that handler.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
