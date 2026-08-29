# The `smithers` agent skill

A drop-in [skill](https://docs.claude.com/en/docs/claude-code/skills) that
teaches a coding agent how to drive **Smithers**, the durable control plane for
long-running coding agents, without making it read the whole documentation site
first. Install it, ask the agent for multi-step or long-running work, and it
reaches for Smithers on its own.

> **Your agent uses Smithers, not you.** Smithers is operated by an AI agent
> (Claude Code, Codex, and others) on your behalf. It is not a GUI you click
> through.

## What is in here

| File | Purpose |
| --- | --- |
| `SKILL.md` | The on-ramp the agent loads: what Smithers is, the sixty-second loop, the Flow, Action, and Plan model, the command surface, and how to operate a run. |
| `llms-full.txt` | The complete Smithers documentation bundle, next to `SKILL.md` so the agent can read the exact API on demand. Generated from the documentation site; do not edit by hand. |

## Install

```sh
npx --package @smthrs/cli smithers skills add
```

`skills add` writes this skill into every agent skill directory it detects and
can write to. Pass `--agent claude` or `--agent codex` to write one agent only.
It installs this one curated skill; it does not generate a skill per CLI
command.

`smithers skills list` shows which agents were detected and whether each already
has the skill.

For an agent with no skill directory, point it at `smithers docs --full`, which
prints the same bundle this directory ships.

## Keeping it fresh

The documentation pipeline generates `llms-full.txt`: it writes
`docs/llms-full.txt`, optimizes it, and mirrors the bundled copies here and in
`packages/cli/docs`. Run `pnpm docs:llms` after editing the documentation so the
bundles never drift.

## The companion skills

Four narrower skills sit beside this one and are installed the same way:

| Skill | When to load it |
| --- | --- |
| `schema-author` | A step's output feeds a later step, a branch, or a loop condition. |
| `prompt-author` | The graph is right but one step's prompt underperforms. |
| `risk-reviewer` | A flow performs outward-facing or irreversible actions. |
| `migrate-smithers-v1` | The project is still on Smithers 0.x and its JSX authoring API. |
