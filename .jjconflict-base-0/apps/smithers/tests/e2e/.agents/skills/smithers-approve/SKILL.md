---
name: smithers-approve
description: Approve a paused approval gate. Auto-detects the pending node if only one exists. Run `smithers approve --help` for usage details.
requires_bin: smithers
command: smithers approve
---

# smithers approve

Approve a paused approval gate. Auto-detects the pending node if only one exists.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | yes | Run ID containing the approval gate |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--node` | `string` |  | Node ID (required if multiple pending) |
| `--iteration` | `number` |  | Loop iteration number (defaults to the pending gate's iteration) |
| `--note` | `string` |  | Approval/denial note |
| `--by` | `string` |  | Name or identifier of the approver |
