# The `smithers` agent skill

A drop-in [skill](https://docs.claude.com/en/docs/claude-code/skills) that teaches
your coding agent how to drive **Smithers**, the durable control plane for
long-running coding agents, without making it read the whole docs site first: it
shortens the path to the aha moment. Install it, ask your agent for some
multi-step or long-running work, and it reaches for Smithers on its own.

> **Your agent uses Smithers, not you.** Smithers is operated by an AI agent
> (Claude Code, Codex, …) on your behalf, not clicked through a GUI.

## What's in here

| File | Purpose |
|---|---|
| `SKILL.md` | The on-ramp the agent loads: what Smithers is, the 60-second loop, the mental model, how to operate runs. |
| `llms-full.txt` | The complete Smithers docs bundle, next to `SKILL.md` so the agent can read the exact API on demand. Generated from the docs; do not edit by hand. |

## Install

`smithers init` auto-installs the curated onboarding skill into detected agents
whose skill directory it can write to today: Claude Code and Pi. To sync the
generated Smithers CLI skill set manually:

```bash
bunx smthrs skills add
```

Use `--no-global` to scope the skill to the current project, not the global agent
directory. `skills add` has no `--agent` target filter; use `mcp add --agent
<name>` to target one MCP integration.

For agents without a skills directory, point them at
`bunx smthrs docs-full` (prints the same `llms-full.txt`), or
`bunx smthrs ask "<question>"`.

## Keeping it fresh

The repo root docs script generates `llms-full.txt`: it writes
`docs/llms-full.txt`, optimizes it, and mirrors this bundled copy. Run
`pnpm docs:llms` after editing the docs so the bundles never drift.
