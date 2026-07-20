---
name: smithers-snapshots
description: List durability snapshots (workspace checkpoints) for a run. Run `smithers snapshots --help` for usage details.
requires_bin: smithers
command: smithers snapshots
---

# smithers snapshots

List durability snapshots (workspace checkpoints) for a run.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | yes | Run ID to list snapshots for |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--json` | `boolean` | `false` | Emit rows as JSON |
