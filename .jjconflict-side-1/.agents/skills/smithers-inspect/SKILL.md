---
name: smithers-inspect
description: Output detailed run state, including steps, agents, approvals, and outputs. Run `smithers inspect --help` for usage details.
requires_bin: smithers
command: smithers inspect
---

# smithers inspect

Output detailed run state, including steps, agents, approvals, and outputs.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | yes | Run ID to inspect |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--watch` | `boolean` | `false` | Watch mode: refresh output continuously |
| `--interval` | `number` | `2` | Watch refresh interval in seconds |
