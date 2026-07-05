# agent-contract/

Models the "Smithers agent contract": the categorized Smithers MCP tool
surface (workflows / runs / approvals / debug / admin) advertised to an agent
connected to Smithers.

- `createSmithersAgentContract.js` buckets a server's listed tools into
  `SmithersAgentContractTool` entries by per-category name sets and flags
  destructive tools.
- `renderSmithersAgentPromptGuidance.js` renders the contract into prompt
  guidance text injected into agent system prompts.
- The `.ts` files (`SmithersAgentContract`, `SmithersAgentContractTool`,
  `SmithersAgentToolCategory`, `SmithersListedTool`, `SmithersToolSurface`)
  are type-only sidecars.
- `index.js` is the barrel (its `@smithers-type-exports` typedef block is
  tool-managed); both functions are also re-exported from `src/index.js` and
  via the package's `./agent-contract` export.

Consumed by the CLI/MCP server when exposing Smithers tools to agents;
covered by `tests/agent-contract.test.js`.
