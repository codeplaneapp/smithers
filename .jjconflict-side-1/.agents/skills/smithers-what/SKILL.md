---
name: smithers-what
description: "Summarize what happened in a run or node: a cheap fast agent narrates the recorded facts (deterministic recap when no agent is available). Run `smithers what --help` for usage details."
requires_bin: smithers
command: smithers what
---

# smithers what

Summarize what happened in a run or node: a cheap fast agent narrates the recorded facts (deterministic recap when no agent is available).

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | no | Run ID to explain (default: latest run) |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--node` | `string` |  | Node ID: explain one node instead of the whole run |
| `--iteration` | `number` |  | Loop iteration number (default: latest iteration) |
| `--json` | `boolean` | `false` | Output structured JSON (summary, agentId, source, facts) |
| `--timeout` | `number` |  | Narrator agent timeout in seconds (default 60) |
