---
name: smithers-timetravel
description: Time-travel to a previous task state by reverting filesystem state, resetting DB state, and optionally resuming. Run `smithers timetravel --help` for usage details.
requires_bin: smithers
command: smithers timetravel
---

# smithers timetravel

Time-travel to a previous task state by reverting filesystem state, resetting DB state, and optionally resuming.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `workflow` | `string` | yes | Workflow ID (from `smithers workflow list`) or path to a .tsx workflow file |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--runId` | `string` |  | Run ID |
| `--nodeId` | `string` |  | Task/node ID to travel back to |
| `--iteration` | `number` | `0` | Loop iteration |
| `--attempt` | `number` |  | Attempt number (default: latest) |
| `--vcs` | `boolean` | `true` | Revert filesystem state. Use --no-vcs to skip (DB only). |
| `--deps` | `boolean` | `true` | Also reset dependents. Use --no-deps to reset only this node. |
| `--resume` | `boolean` | `false` | Resume the workflow after time travel |
| `--force` | `boolean` | `false` | Force even if run is still running |
