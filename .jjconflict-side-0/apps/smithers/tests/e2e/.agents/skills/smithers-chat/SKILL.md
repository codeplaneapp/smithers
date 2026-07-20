---
name: smithers-chat
description: Show agent chat output for the latest run or a specific run. Run `smithers chat --help` for usage details.
requires_bin: smithers
command: smithers chat
---

# smithers chat

Show agent chat output for the latest run or a specific run.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | no | Run ID to inspect (default: latest run) |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--all` | `boolean` | `false` | Show all agent attempts in the run (default: latest only) |
| `--follow` | `boolean` | `false` | Watch for new agent output |
| `--tail` | `number` |  | Show only the last N chat blocks |
| `--stderr` | `boolean` | `true` | Include agent stderr output |
