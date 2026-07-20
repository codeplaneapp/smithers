---
name: smithers-status
description: "Concise run health at a glance: verdict, node counts, agent/model mix, throughput, and the nodes gating progress. Run `smithers status --help` for usage details."
requires_bin: smithers
command: smithers status
---

# smithers status

Concise run health at a glance: verdict, node counts, agent/model mix, throughput, and the nodes gating progress.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | yes | Run ID to summarize |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--json` | `boolean` | `false` | Output the structured summary as JSON |
| `--window` | `number` |  | Recent-activity window in minutes for the throughput/verdict checks (default 10) |
