---
name: smithers-init
description: Install the local Smithers workflow pack into .smithers/. Pass an optional prompt to also launch the create-workflow builder after init. Run `smithers init --help` for usage details.
requires_bin: smithers
command: smithers init
---

# smithers init

Install the local Smithers workflow pack into .smithers/. Pass an optional prompt to also launch the create-workflow builder after init.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `prompt` | `string` | no | Optional plain-English task: after init, launch the create-workflow builder with this prompt pre-filled |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--agent` | `string` |  | Preferred coding agent id (e.g. claude, codex, pi). Skips the interactive agent question. |
| `--tutorial` | `boolean` | `true` | After install, open a hijacked tutorial session hosted by your preferred agent (interactive init only). Use --no-tutorial to skip. |
| `--force` | `boolean` | `false` | Overwrite existing scaffold files |
| `--agentsOnly` | `boolean` | `false` | Only create .smithers/agents/ and leave the rest of the workflow pack untouched |
| `--install` | `boolean` | `true` | Run `bun install` inside .smithers/ after scaffolding (--no-install to skip) |
| `--addAgents` | `boolean` | `false` | After scaffolding, launch the interactive `agents add` wizard to register one or more accounts. |
| `--skill` | `boolean` | `true` | Install the curated `smithers` skill into your detected coding agents (Claude Code, Pi, Codex, OpenCode, Kimi, Amp, Antigravity) and, if a CLAUDE.md or AGENTS.md exists, append guidance on when to use smithers.sh workflows. Use --no-skill to skip. |
| `--global` | `boolean` | `false` | Scaffold the global pack in ~/.smithers (honors SMITHERS_HOME) instead of ./.smithers. Global workflows run from any repo; a repo's local pack takes precedence. |
| `--updatePrompt` | `boolean` | `true` | In an interactive terminal, when shipped pack files differ from the latest bundled version, ask which to update (warning when a shared component is selected). Use --no-update-prompt to skip the question. |
| `--template` | `unknown` |  | Show next steps for a canonical starter template ID after init |
| `--yes` | `boolean` | `false` | Non-interactive: skip prompts and use defaults (safe for agents and CI). Alias: --non-interactive. |
| `--nonInteractive` | `boolean` | `false` | Non-interactive: skip prompts and use defaults (safe for agents and CI). Alias: --yes. |
