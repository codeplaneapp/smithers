---
name: smithers-scores
description: View scorer results for a specific run. Run `smithers scores --help` for usage details.
requires_bin: smithers
command: smithers scores
---

# smithers scores

View scorer results for a specific run.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | yes | Run ID to inspect |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--node` | `string` |  | Filter scores to a specific node ID |
