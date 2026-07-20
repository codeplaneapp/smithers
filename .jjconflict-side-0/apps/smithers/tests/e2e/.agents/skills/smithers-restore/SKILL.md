---
name: smithers-restore
description: Restore a worktree to a durability checkpoint (latest for the node, or --seq). Run `smithers restore --help` for usage details.
requires_bin: smithers
command: smithers restore
---

# smithers restore

Restore a worktree to a durability checkpoint (latest for the node, or --seq).

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | yes | Run ID containing the checkpoint |
| `nodeId` | `string` | yes | Node ID whose worktree to restore |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--iteration` | `number` |  | Loop iteration |
| `--seq` | `number` |  | Checkpoint seq (default: latest) |
