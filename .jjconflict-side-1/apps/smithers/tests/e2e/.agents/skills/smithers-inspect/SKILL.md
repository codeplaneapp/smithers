---
name: smithers-inspect
description: Output detailed run state. Structured output canonically uses nodes[].nodeId (legacy steps[].id remains for compatibility); --pool tallies attempt engine/model usage. Run `smithers inspect --help` for usage details.
requires_bin: smithers
command: smithers inspect
---

# smithers inspect

Output detailed run state. Structured output canonically uses nodes[].nodeId (legacy steps[].id remains for compatibility); --pool tallies attempt engine/model usage.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | yes | Run ID to inspect |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--watch` | `boolean` | `false` | Watch mode: refresh output continuously |
| `--interval` | `number` | `2` | Watch refresh interval in seconds |
| `--pool` | `boolean` | `false` | Tally attempts by agent engine/model |
