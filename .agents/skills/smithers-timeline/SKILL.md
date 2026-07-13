---
name: smithers-timeline
description: View execution timeline for a run and its forks (time travel). Run `smithers timeline --help` for usage details.
requires_bin: smithers
command: smithers timeline
---

# smithers timeline

View execution timeline for a run and its forks (time travel).

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | yes | Run ID |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--tree` | `boolean` | `false` | Include all child forks recursively |
| `--json` | `boolean` | `false` | Output as JSON |
