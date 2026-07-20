---
name: smithers-revert
description: Revert the workspace to a previous task attempt's filesystem state. Run `smithers revert --help` for usage details.
requires_bin: smithers
command: smithers revert
---

# smithers revert

Revert the workspace to a previous task attempt's filesystem state.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `workflow` | `string` | yes | Workflow ID (from `smithers workflow list`) or path to a .tsx workflow file |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--runId` | `string` |  | Run ID to revert |
| `--nodeId` | `string` |  | Node ID to revert to |
| `--attempt` | `number` | `1` | Attempt number |
| `--iteration` | `number` | `0` | Loop iteration number |
