---
name: smithers-logs
description: Tail the event log of a specific run. Run `smithers logs --help` for usage details.
requires_bin: smithers
command: smithers logs
---

# smithers logs

Tail the event log of a specific run.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | yes | Run ID to tail |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--follow` | `boolean` | `true` | Keep tailing (default true for active runs) |
| `--fromSeq` | `number` |  | Start from event sequence number (exclusive) |
| `--since` | `number` |  | Deprecated alias of --from-seq: an event SEQUENCE NUMBER, not a duration (`events --since` takes a duration window like 5m) |
| `--tail` | `number` | `50` | Show last N events first |
| `--followAncestry` | `boolean` | `false` | Include events from ancestor runs (continuation lineage) |
