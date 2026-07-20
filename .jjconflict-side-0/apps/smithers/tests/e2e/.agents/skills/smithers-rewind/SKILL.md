---
name: smithers-rewind
description: Rewind a run to a previous frame. Run `smithers rewind --help` for usage details.
requires_bin: smithers
command: smithers rewind
---

# smithers rewind

Rewind a run to a previous frame.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | yes | Run ID to rewind |
| `frameNo` | `number` | yes | Target frame number |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--yes` | `boolean` | `false` | Skip confirmation |
| `--json` | `boolean` | `false` | Emit JumpResult JSON |
