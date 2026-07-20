---
name: smithers-events
description: Query node/run lifecycle history by default; pass --raw for raw agent chunks and all event types. Run `smithers events --help` for usage details.
requires_bin: smithers
command: smithers events
---

# smithers events

Query node/run lifecycle history by default; pass --raw for raw agent chunks and all event types.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | yes | Run ID to query |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--node` | `string` |  | Filter events by node ID |
| `--type` | `string` |  | Filter by event category (agent, approval, frame, memory, node, openapi, output, revert, run, sandbox, scorer, snapshot, supervisor, timer, token, tool-call, workflow) |
| `--since` | `string` |  | Filter to a recent duration window (e.g. 5m, 2h; a bare number is milliseconds, and `logs --since` is an event sequence number instead) |
| `--limit` | `number` |  | Maximum events to display (default 1000, max 100000) |
| `--json` | `boolean` | `false` | Output NDJSON for piping |
| `--groupBy` | `string` |  | Group output by "node" or "attempt" |
| `--watch` | `boolean` | `false` | Watch mode: append new events as they arrive |
| `--interval` | `number` | `2` | Watch poll interval in seconds |
| `--raw` | `boolean` | `false` | Include raw agent chunk/tool history instead of the default lifecycle-only view |
