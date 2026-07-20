---
name: smithers-diff
description: Print DiffBundle as unified diff. Run `smithers diff --help` for usage details.
requires_bin: smithers
command: smithers diff
---

# smithers diff

Print DiffBundle as unified diff.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | yes | Run ID containing the node |
| `nodeId` | `string` | yes | Node ID to diff |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--iteration` | `number` |  | Loop iteration |
| `--json` | `boolean` | `false` | Emit raw DiffBundle |
| `--stat` | `boolean` | `false` | Show stat summary only |
| `--color` | `string` | `auto` | Colorize output |
