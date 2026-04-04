# Canonical semantic Smithers MCP namespace

## Problem

The live Smithers MCP server currently auto-exposes raw CLI commands. That is
useful as an escape hatch, but it is the wrong primary interface for agents.

Today the exported tool list includes raw names such as:

- `up`
- `ps`
- `inspect`
- `node`
- `why`
- `approve`
- `deny`
- `workflow_run`
- `workflow_list`
- `cron_add`
- `tui`
- `observability`

That means:

- agents need to learn CLI names, flags, and textual output formats
- prompt writers have to know which raw command to call
- tool names drift whenever the CLI is reorganized
- agents are exposed to commands that are not useful or safe as default tools
  (`tui`, `observability`, `down`)
- PI and `smithers ask` have no stable semantic layer to teach

Smithers needs a stable agent-tool namespace that models orchestrator concepts,
not CLI implementation details.

## Proposal

Add a semantic Smithers MCP namespace and keep the raw CLI surface as a separate
escape hatch.

### Semantic tool set

Start with a minimal stable tool family:

```txt
list_workflows
run_workflow
list_runs
get_run
watch_run
explain_run
list_pending_approvals
resolve_approval
get_node_detail
revert_attempt
list_artifacts
get_chat_transcript
get_run_events
```

These names should stay stable even if the raw CLI commands keep changing.

### Design rules

1. Tool names are noun/verb orchestration concepts, not CLI command names.
2. Tool inputs are structured and concise.
3. Tool outputs are structured JSON first; pretty text rendering is secondary.
4. Every destructive tool declares that fact in metadata and descriptions.
5. Long-running operations have explicit watch/poll semantics.

### Raw escape hatch

Keep the raw CLI-as-MCP surface, but separate it clearly:

- server name: `smithers-raw`
- or tool prefix: `raw_*`
- or `--mcp --surface raw|semantic|both`

The default surface for `smithers ask`, PI, and future skills should be
`semantic`, not `raw`.

### New CLI features

Implement real MCP operator commands:

- `smithers mcp add --agent <agent> --surface <semantic|raw|both>`
- `smithers mcp print-config --agent <agent> --surface <semantic|raw|both>`
- `smithers mcp list-tools --surface <semantic|raw|both>`

The docs already mention `mcp add`; this ticket should either make that command
real or remove the docs until it is.

## Rollout phases

### Phase 1: Semantic tool contract

- Define schemas and output contracts for the semantic tools.
- Add a dedicated semantic MCP server or semantic tool surface mode.
- Add contract tests for `listTools()`.

### Phase 2: Adopt semantic tools in agent-facing surfaces

- Switch `smithers ask` prompt generation to semantic tools.
- Switch PI prompt guidance to semantic tools.
- Update docs and skill packs.

### Phase 3: Raw escape hatch and operator tooling

- Keep raw CLI MCP available behind an explicit surface choice.
- Implement `smithers mcp add` and `smithers mcp print-config`.

## Additional steps

1. Build semantic tools on top of existing services, not by re-parsing CLI text.
2. Reuse `SmithersService`-style DB/service calls where possible.
3. Add consistent output schemas for run summaries, approvals, node details, and
   event streams.
4. Provide a migration path for existing prompt content that still refers to raw
   tools.
5. Decide whether `watch_run` is:
   - a poll-until-terminal tool
   - or a stream-oriented tool with cursors/checkpoints
6. Hide non-agent UI/admin commands from the default semantic surface.

## Verification requirements

### Unit and integration tests

1. **Semantic surface exports expected tools** - `listTools()` on the semantic
   server returns the stable tool family and nothing UI-only.
2. **Raw surface still exports raw tools** - Raw CLI MCP remains available for
   escape-hatch use.
3. **`list_runs` output is structured** - Output schema is stable and does not
   depend on CLI table formatting.
4. **`run_workflow` wraps existing execution paths** - Starting a workflow
   through the semantic tool returns run ID, status, and launch metadata.
5. **`watch_run` completes correctly** - Watches a run through running,
   waiting-approval, and terminal states.
6. **`resolve_approval` handles ambiguity** - Clear error when more than one
   pending approval matches the request.
7. **`get_node_detail` exposes enriched node data** - Includes attempts, tool
   calls, and output in stable structured fields.
8. **`mcp add` prints correct config** - Generated MCP config for Claude and
   Codex is valid for the requested surface.

### Corner cases

9. **No database found** - Read tools return a structured not-found error.
10. **Finished run watch** - `watch_run` on an already terminal run returns once
    and exits cleanly.
11. **Unsafe tools hidden by default** - UI-only/admin tools do not leak into the
    semantic default surface.

## Observability

### New events

- `SemanticMcpToolCalled { toolName, agentId, timestampMs }`
- `SemanticMcpFallbackToRaw { toolName, reason, timestampMs }`
- `SemanticMcpWatchCompleted { runId, terminalStatus, timestampMs }`

### New metrics

- `smithers.mcp.semantic_calls_total{tool}`
- `smithers.mcp.raw_calls_total{tool}`
- `smithers.mcp.semantic_fallback_total`
- `smithers.mcp.watch_duration_ms`

### Logging

- `Effect.withLogSpan("mcp:semantic")`
- Annotate with `{ toolName, surface, runId }`

## Codebase context

### Smithers files

- `src/cli/index.ts` - current `--mcp` behavior and command registry
- `src/cli/workflows.ts` - workflow discovery helpers
- `src/cli/node-detail.ts` - basis for `get_node_detail`
- `src/cli/why-diagnosis.ts` - basis for `explain_run`
- `src/engine/approvals.ts` - approval resolution
- `src/cli/tui-v2/broker/SmithersService.ts` - service-layer helpers worth
  reusing instead of shelling through the CLI
- `docs/cli/overview.mdx` - currently documents `mcp add` without implementation

## Effect.ts architecture

The semantic MCP layer should call Effect-based services directly. Do not shell
out to the CLI and scrape its text output in order to implement semantic tools.
