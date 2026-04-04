# `smithers ask` and agent contract drift cleanup

## Problem

Smithers already has a live local MCP server via `smithers --mcp`, but the
agent-facing glue around it has drifted badly:

- `src/cli/ask.ts` still claims Codex has no MCP support and falls back to a
  bash-only prompt, even though the installed Codex CLI exposes `codex mcp`.
- `src/cli/ask.ts` advertises a remote `smithers-docs` MCP server, but the
  generated config only wires the local orchestrator server. The constant and
  prompt claim are stale.
- `src/cli/ask.ts` hardcodes stale tool names such as `smithers_runs_list` and
  `smithers_workflow_up`, but the live `--mcp` export is raw CLI-shaped and
  currently exposes names like `ps`, `inspect`, `up`, `workflow_run`, `approve`,
  `node`, and `why`.
- `src/pi-plugin/extension.ts` dynamically imports the real MCP tools at
  runtime, but its injected prompt still teaches stale names like
  `smithers_run`, `smithers_status`, and `smithers_list`.
- `README.md` still uses `smithers run`, `smithers resume`, and `smithers list`,
  while `docs/cli/overview.mdx` explicitly says those names are stale.
- `docs/cli/overview.mdx` also documents `mcp add`, `skills add`, `tui --attach`,
  and `tui --broker-only`, but those command surfaces are not implemented in
  `src/cli/index.ts`.

This is not a small docs issue. It means agents are being taught the wrong
control plane, operator guidance is inconsistent, and there is no test to stop
future drift.

## Proposal

Create a single source of truth for Smithers' agent-facing command/tool
contract, then drive `ask`, the PI extension, and docs from it.

### Contract source of truth

Add a shared helper module, for example:

```ts
type SmithersAgentContract = {
  toolSurface: "raw" | "semantic";
  serverName: string;
  tools: Array<{
    name: string;
    description: string;
    destructive: boolean;
    category: "runs" | "approvals" | "workflows" | "debug" | "admin";
  }>;
  promptGuidance: string;
  docsGuidance: string;
};
```

This helper should be able to:

1. Probe or list the live Smithers MCP tools.
2. Render a prompt snippet that only references real tools.
3. Render a docs snippet or generated markdown table for the CLI docs.

### Immediate cleanup

1. Remove the unimplemented remote docs MCP claim from `ask.ts`.
2. Stop hardcoding stale tool names in prompts.
3. Update PI extension prompt text to describe the real tool surface.
4. Repair or remove stale README and CLI reference examples.
5. If `mcp add`, `skills add`, `tui --attach`, or `tui --broker-only` are not
   implemented yet, stop documenting them as shipped.

### Codex parity inside `ask`

`smithers ask` should treat Codex as a first-class MCP-capable agent, not a
special fallback case. That work is part of this cleanup because keeping Codex
on the wrong path means the contract still diverges by agent.

The implementation can use one of two approaches:

- Generate a temporary project-scoped `.codex/config.toml`.
- Or pass `-c mcp_servers.<name>...` config overrides to `codex exec`.

Do not keep a Codex-only fallback prompt once the local Smithers server can be
wired directly.

### New CLI features

`smithers ask` should become diagnosable:

- `smithers ask --agent <claude|codex|gemini|kimi|pi>`
- `smithers ask --list-agents`
- `smithers ask --dump-prompt`
- `smithers ask --tool-surface <raw|semantic>`
- `smithers ask --no-mcp`
- `smithers ask --print-bootstrap`

These should be operator-facing diagnostics, not hidden flags.

## Rollout phases

### Phase 1: Shared contract and prompt cleanup

- Add the shared contract helper.
- Make `ask.ts` and `src/pi-plugin/extension.ts` consume it.
- Update README and docs to match reality.
- Add a parity test that compares live MCP export to prompt/docs snippets.

### Phase 2: Codex MCP support

- Wire Codex to the local Smithers MCP server.
- Remove the "Codex has no MCP support" branch.
- Add integration tests using a fake `codex` binary.

### Phase 3: Operator diagnostics

- Add `smithers ask` debugging flags.
- Surface why an agent was selected and which bootstrap path was used.

## Additional steps

1. Move prompt-building logic out of `ask.ts` into a reusable helper.
2. Add agent capability checks that distinguish:
   - supports config file MCP
   - supports inline/project MCP
   - supports allow-list-only MCP
   - no MCP
3. Make `detectAvailableAgents()` report MCP bootstrap mode, not just auth state.
4. Ensure Gemini is described accurately: it supports MCP, but via configured
   server names rather than ad hoc JSON config injection.
5. Ensure PI prompt text does not promise commands or tools that do not exist.
6. Add a small docs validation test that fails if README reintroduces `run`,
   `resume`, `status`, or `list` as live CLI commands.
7. If a real docs MCP server is desired later, give it a separate ticket and do
   not predeclare it here.

## Verification requirements

### Unit and integration tests

1. **Contract renderer only references live tools** - Probe the current local
   Smithers MCP server and assert every tool mentioned in generated prompt text
   exists.
2. **PI prompt stays in sync** - Build the PI prompt from a mocked MCP tool list
   and assert stale aliases like `smithers_run` are absent.
3. **README command parity** - Assert README examples only use current command
   names or explicitly label legacy names as stale.
4. **CLI docs parity** - Assert `docs/cli/overview.mdx` does not document command
   families that `src/cli/index.ts` does not actually register.
5. **Codex bootstrap path** - With a fake `codex` binary, assert `smithers ask`
   configures MCP instead of using the fallback no-MCP prompt.
6. **Agent selection diagnostics** - `smithers ask --list-agents` reports usable
   agents plus their MCP bootstrap mode.
7. **No remote docs server by default** - Assert the generated bootstrap config
   only contains the local server unless an explicit docs server flag is set.

### Corner cases

8. **No usable agents installed** - Error remains clear and enumerates checked
   binaries.
9. **Broken MCP bootstrap** - If the local Smithers MCP child fails to start,
   `smithers ask` exits with a clear bootstrap error.
10. **Gemini allow-list mode** - Generated instructions explain that Gemini uses
    preconfigured MCP server names, not an injected JSON config file.
11. **Codex temp config cleanup** - Any generated temporary config files are
    removed after the command exits.

## Observability

### New events

- `AskAgentSelected { agentId, selectionReason, mcpMode, timestampMs }`
- `AskBootstrapStarted { agentId, serverName, toolSurface, timestampMs }`
- `AskBootstrapFailed { agentId, error, timestampMs }`
- `AskContractMismatch { surface, staleNames, timestampMs }`

### New metrics

- `smithers.ask.invocations_total`
- `smithers.ask.bootstrap_ms`
- `smithers.ask.failures_total`
- `smithers.ask.contract_mismatch_total`
- `smithers.ask.agent_selected_total{agentId,mcpMode}`

### Logging

- `Effect.withLogSpan("ask:select-agent")`
- `Effect.withLogSpan("ask:bootstrap-mcp")`
- Annotate with `{ agentId, toolSurface, bootstrapMode }`

## Codebase context

### Smithers files

- `src/cli/ask.ts` - current bootstrap logic and stale prompt text
- `src/cli/agent-detection.ts` - extend with MCP bootstrap capability detection
- `src/agents/CodexAgent.ts` - support Codex MCP bootstrap inputs
- `src/pi-plugin/extension.ts` - dynamic tool registration already exists; prompt
  generation should consume the shared contract
- `src/cli/index.ts` - `ask` command options and actual command registry
- `docs/cli/overview.mdx` - current CLI contract drift
- `README.md` - stale command examples

### External references

- OpenAI Codex MCP docs: project-scoped `.codex/config.toml` and `codex mcp add`
- Claude Code MCP docs: project-scoped `.mcp.json` and `claude mcp add`
- Verified locally on this machine:
  - `codex-cli 0.99.0-alpha.13`
  - `Claude Code 2.1.7`
  - `gemini 0.35.2`
  - `kimi 1.12.0`

## Effect.ts architecture

All internal bootstrap, probing, and contract-generation logic should stay in
Effect. Only the outer CLI command handler in `src/cli/index.ts` should break out
to promises/process exit behavior.
