# eve-style agent authoring for smithers

Status: draft / proposal
Author: will (with Claude)
Date: 2026-06-30

## Summary

Adopt Vercel **eve**'s filesystem-first agent conventions as the canonical way to
author agents in smithers. An agent becomes a directory of files
(`instructions.md`, `tools/*.ts`, `skills/*`, `subagents/*`) that compiles to a
smithers `AgentLike`. The same project also carries a `workflows/` directory that
follows existing smithers CLI conventions. We fork eve's authoring and discovery
layer, drop its runtime (Vercel Workflows / Sandbox / AI Gateway), and run
everything on smithers' durable engine.

This closes a real gap: today smithers agents are provider wrappers. You pick a
model and a failover pool. You cannot author a *custom* agent with its own
instructions, hand-written tools, skills, and subagents. eve's conventions are
exactly a custom-agent authoring format, and eve is a thin layer over the AI SDK
that smithers already depends on, so this is additive rather than breaking.

## Motivation

### The gap

`.smithers/agents.ts` today looks like this:

```ts
export const providers = {
  claude: new SmithersClaudeCodeAgent({ model: "claude-fable-5" }),
  codex:  new SmithersCodexAgent({ model: "gpt-5.5", skipGitRepoCheck: true }),
} as const;

export const agents = {
  cheapFast: [providers.claudeSonnet, providers.codex],
} as const satisfies Record<string, AgentLike[]>;
```

The customization surface stops at "which provider class, which model, which
pool." There is no first-class way to say "this agent has these three tools, this
system prompt, and delegates X to a subagent." Users who want a custom agent have
to drop to raw AI SDK `ToolLoopAgent` construction and lose the smithers
conventions around it.

### Why eve is the right shape to borrow

eve already solved the authoring ergonomics, and it did so on top of the AI SDK
that smithers extends:

- `agent/agent.ts` exports `defineAgent({ model })`.
- `agent/instructions.md` is the system prompt. Instructions alone is a valid agent.
- `agent/tools/get_weather.ts` exports `defineTool({ description, inputSchema, execute })`.
  The filename is the tool name. No registration.
- `agent/skills/*` are markdown playbooks loaded on demand.
- `agent/subagents/*` are child agents with their own config and tools.

eve's `defineTool` is the AI SDK `tool()` signature. eve's `defineAgent` resolves
a model string and runs a `ToolLoopAgent` loop. AI SDK 7 even ships
`WorkflowAgent`, a durability wrapper for `ToolLoopAgent`, because a plain agent
loop runs in memory and loses state on crash. That wrapper is the exact role
smithers' engine already plays. So the fork boundary is clean: take eve's
authoring layer, replace its runtime with ours.

### Non-breaking

smithers depends on `ai ^6.0.168` across `packages/agents`, `packages/openapi`,
`packages/smithers`, `apps/smithers`. Native agents (`AnthropicAgent.js`,
`OpenAIAgent.js`) already extend AI SDK `ToolLoopAgent`, and `defineTool` in
`packages/smithers/src/tools/defineTool.js` already wraps AI SDK `tool()`. Adding
an eve-style loader produces `AgentLike` instances that flow through the existing
`<Task agent={...}>` path untouched. Nothing existing changes behavior. This is a
new canonical authoring style layered over the current one.

Open dependency question to resolve during implementation: eve tracks current AI
SDK (the 7 line). Confirm whether the vendored loader needs types from AI SDK 7 or
works against the 6.x we pin, and whether a coordinated bump to 7 is required. See
Open Questions.

## Goals

1. Author a custom agent as a directory, compiled to a smithers `AgentLike`.
2. Unify declaration: CLI harness adapters (`ClaudeCodeAgent`, `CodexAgent`, ...)
   and SDK/custom agents are declared through the same eve-compatible API.
3. Keep `workflows/*.tsx` in the same project, discovered and run by the
   `smithers` CLI exactly as `.smithers/workflows/*` are today.
4. Run on smithers' engine: durability, snapshots, time-travel, fork, approval
   gates, sandbox. No Vercel runtime dependency.
5. Zero behavior change for existing workflows and `.smithers/agents.ts` setups.

## Non-goals

- Reimplementing eve's channels (Slack/Discord/HTTP), AI Gateway, Vercel Sandbox,
  or Vercel Workflows. smithers owns these seams.
- Deploying to Vercel. eve's deploy target is out of scope.
- Dropping the existing provider-pool authoring style. It stays valid.

## Design

### Directory layout

One project directory is both an eve-style agent definition and a smithers
workflow pack:

```
my-agent/
  agent/
    agent.ts            defineAgent(...) -> resolved to a smithers AgentLike
    instructions.md     system prompt
    tools/*.ts          one defineTool per file; filename is the tool name
    skills/*.md         on-demand playbooks
    subagents/*/        nested agent/ dirs, same conventions, recursively
  workflows/*.tsx       smithers workflow convention, run by `smithers` CLI
```

For the repo itself, these live under `.smithers/` as today. `.smithers/agents/<name>/`
holds custom agent directories, and `.smithers/workflows/` is unchanged.

### Seam 1: `defineAgent` compiles to `AgentLike`

We fork eve's `defineAgent` and its directory loader into a smithers package
(proposed `packages/agent-kit`, or folded into `packages/agents`). The forked
`defineAgent` returns a smithers `AgentLike` rather than an eve runtime app.

```ts
// .smithers/agents/researcher/agent.ts
import { defineAgent } from "smithers-orchestrator/agent-kit";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",   // resolved via resolveSdkModel, not AI Gateway
  // instructions.md, tools/, skills/, subagents/ auto-discovered by sibling files
});
```

Compilation maps eve concepts to existing smithers primitives:

| eve concept            | smithers target                                          |
| ---------------------- | -------------------------------------------------------- |
| `instructions.md`      | system prompt on the `ToolLoopAgent`-backed `AgentLike`  |
| `tools/*.ts` `defineTool` | `packages/smithers/src/tools/defineTool.js` (already AI SDK `tool()`) |
| `skills/*.md`          | on-demand context injection (existing skills mechanism)  |
| `subagents/*`          | delegated agent, exposed to the parent as a tool         |
| `model` string         | `resolveSdkModel` (`packages/agents/src/resolveSdkModel.js`) |

The compiled agent is a normal `AgentLike`, so it drops into any workflow:

```tsx
import researcher from "../agents/researcher/agent";

<Task id="research" output={schema} agent={researcher}>
  <ResearchPrompt />
</Task>
```

`tools/*.ts` uses the smithers `defineTool` re-export so authored tools get ambient
tool-context and idempotency for free:

```ts
// .smithers/agents/researcher/tools/search_web.ts
import { defineTool } from "smithers-orchestrator/agent-kit";
import { z } from "zod";

export default defineTool({
  description: "Search the web and return top results.",
  inputSchema: z.object({ query: z.string() }),
  async execute(input, ctx) {
    return await ctx.tools.webSearch(input.query);
  },
});
```

### Seam 2: harness adapters use the same API

CLI harness agents must be declarable through the same `defineAgent` surface. We
add a discriminator so `defineAgent` produces either an SDK-backed custom agent or
a harness-backed agent, both returning `AgentLike`:

```ts
// SDK / custom agent
export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
});

// CLI harness agent (Claude Code, Codex, ...)
export default defineAgent({
  harness: "claude-code",           // maps to ClaudeCodeAgent
  model: "claude-fable-5",
  options: { skipGitRepoCheck: true },
});
```

`harness` resolves to the existing adapter classes in `packages/agents/src/`
(`ClaudeCodeAgent`, `CodexAgent`, `GeminiAgent`, ...) via `BaseCliAgent`. For
harness agents, `instructions.md` becomes the harness system prompt where the CLI
supports it, and `tools/*.ts` are exposed as MCP tools to the CLI (reusing
`createMcpToolset`) since CLI harnesses consume tools over MCP rather than the SDK
tool loop. Pools stay expressible: an array of `defineAgent` results is a failover
pool exactly as today.

Result: one declaration form covers native SDK agents, custom file-authored
agents, and CLI harness agents.

### Seam 3: `workflows/` and the CLI

No change to workflow authoring. The `smithers` CLI already discovers
`.smithers/workflows/*.tsx`. Agents authored under `.smithers/agents/<name>/`
resolve by import (as shown) and by a lookup helper so workflows and the CLI can
reference agents by directory name. `smithers init` scaffolds an example custom
agent directory alongside the seeded `hello` workflow.

### Runtime: smithers replaces eve's runtime

eve sessions run on Vercel Workflows with Vercel Sandbox and AI Gateway. We keep
none of that. The compiled `AgentLike` runs inside a smithers `<Task>`, so it
inherits the engine's durability, snapshots, time-travel, fork, approval gates,
and the smithers sandbox (`packages/sandbox`, Freestyle VMs). eve's
`WorkflowAgent` durability wrapper is unnecessary because the engine is the
durability layer.

## Fork boundary: what we vendor vs. drop

Vendor (adapt API to smithers):

- Directory discovery and manifest compilation for `agent/`.
- `defineAgent` config schema and resolution.
- `defineTool` file loader (the export shape is already AI SDK `tool()`).
- Skill discovery and on-demand loading.
- Subagent nesting and delegation-as-tool.

Drop (smithers already owns or does not need):

- Vercel Workflows session runtime and event log.
- Vercel Sandbox integration.
- AI Gateway model routing (use `resolveSdkModel`).
- Vercel Connect, channels (Slack/Discord/HTTP), Agent Runs dashboard.

Because eve is Apache-2.0, vendoring with attribution is fine. The user's stated
preference is to copy eve code and reshape small API differences rather than depend
on `eve` as a package, which also frees us from its Vercel-runtime dependencies.

## Migration and compatibility

- Existing `.smithers/agents.ts` provider pools keep working. `defineAgent` output
  is assignable to `AgentLike`, so old and new mix in the same pool.
- Existing workflows are untouched.
- Docs update: a new "authoring a custom agent" guide plus regenerated
  `llms-*.txt` bundles (`pnpm docs:llms`, gated by `check-docs` / `check-llms`).

## Open questions

1. **AI SDK version.** Does the vendored loader require AI SDK 7 types, or does it
   compile against the pinned 6.x? If 7 is required, scope a coordinated bump of
   `ai` across `packages/agents`, `packages/openapi`, `packages/smithers`,
   `apps/smithers` as a prerequisite change. Confirm by reading eve's source and
   its `package.json` peer range.
2. **Exact `defineAgent` options.** Enumerate eve's full option set (reasoning
   controls, tool approval, context) from source and decide which we honor vs.
   drop. Tool approval should map to smithers approval-gate nodes.
3. **Harness tool exposure.** Confirm the MCP path for exposing `tools/*.ts` to CLI
   harnesses that do not use the SDK tool loop, and whether all target harnesses
   support system-prompt injection from `instructions.md`.
4. **Skills mechanism reuse.** Reconcile eve's on-demand skill loading with the
   existing smithers skills so there is one skills concept, not two.
5. **Package placement.** New `packages/agent-kit` vs. folding into
   `packages/agents`. Respect dependency-boundary gate (`check-dependency-boundaries`).

## Rollout

1. Land the vendored loader and `defineAgent` -> `AgentLike` compiler with unit
   tests (test-first, real backends, no mocks).
2. Add harness discriminator so CLI adapters declare through the same API.
3. Scaffold example custom agent in `smithers init`; add e2e that inits, defines a
   custom agent with one tool, and runs a workflow that drives it.
4. Docs + regenerated llms bundles.
5. Reframe `.smithers/agents.ts` guidance to present directory-authored agents as
   the canonical style, keeping pool arrays as the composition mechanism.
