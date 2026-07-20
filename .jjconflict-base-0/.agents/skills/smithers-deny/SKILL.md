---
name: smithers-deny
description: Deny a paused approval gate. Run `smithers deny --help` for usage details.
requires_bin: smithers
command: smithers deny
---

# smithers deny

Deny a paused approval gate.

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
