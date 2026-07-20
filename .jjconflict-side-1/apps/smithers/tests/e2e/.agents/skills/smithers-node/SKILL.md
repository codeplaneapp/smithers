---
name: smithers-node
description: Show enriched node details for debugging retries, tool calls, and output. Run `smithers node --help` for usage details.
requires_bin: smithers
command: smithers node
---

# smithers node

Show enriched node details for debugging retries, tool calls, and output.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `nodeId` | `string` | yes | Node ID to inspect |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--runId` | `string` |  | Run ID containing the node |
| `--iteration` | `number` |  | Loop iteration number (default: latest iteration) |
| `--attempts` | `boolean` | `false` | Expand all attempts in human output |
| `--tools` | `boolean` | `false` | Expand tool input/output payloads in human output |
| `--watch` | `boolean` | `false` | Watch mode: refresh output continuously |
| `--interval` | `number` | `2` | Watch refresh interval in seconds |
