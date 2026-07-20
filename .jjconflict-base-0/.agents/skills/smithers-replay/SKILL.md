---
name: smithers-replay
description: Fork from a checkpoint and resume execution (time travel). Run `smithers replay --help` for usage details.
requires_bin: smithers
command: smithers replay
---

# smithers replay

Fork from a checkpoint and resume execution (time travel).

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `workflow` | `string` | yes | Workflow ID (from `smithers workflow list`) or path to a .tsx workflow file |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--runId` | `string` |  | Source run ID to replay from |
| `--frame` | `number` |  | Frame number to fork from |
| `--node` | `string` |  | Node ID to reset to pending |
| `--input` | `string` |  | Input overrides as JSON string |
| `--label` | `string` |  | Branch label for the fork |
| `--restoreVcs` | `boolean` | `false` | Restore jj filesystem state to the source frame's revision |
