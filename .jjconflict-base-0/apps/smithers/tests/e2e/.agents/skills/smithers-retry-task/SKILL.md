---
name: smithers-retry-task
description: Retry a specific task within a run, then resume the workflow. Run `smithers retry-task --help` for usage details.
requires_bin: smithers
command: smithers retry-task
---

# smithers retry-task

Retry a specific task within a run, then resume the workflow.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `workflow` | `string` | yes | Workflow ID (from `smithers workflow list`) or path to a .tsx workflow file |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--runId` | `string` |  | Run ID containing the task |
| `--nodeId` | `string` |  | Task/node ID to retry |
| `--iteration` | `number` | `0` | Loop iteration |
| `--deps` | `boolean` | `true` | Also reset dependents. Use --no-deps to reset only this node. |
| `--force` | `boolean` | `false` | Allow retry even if run is still running |
