---
name: smithers-graph
description: Render the workflow graph without executing it. Run `smithers graph --help` for usage details.
requires_bin: smithers
command: smithers graph
---

# smithers graph

Render the workflow graph without executing it.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `workflow` | `string` | yes | Workflow ID (from `smithers workflow list`) or path to a .tsx workflow file |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--runId` | `string` | `graph` | Run ID for context |
| `--input` | `string` |  | Input data as JSON |
| `--root` | `string` |  | Tool sandbox root directory (same semantics as `up`) |
| `--compact` | `boolean` | `false` | Omit task prompt/text bodies (structure only) — validate that a workflow compiles without flooding output with every prompt |
