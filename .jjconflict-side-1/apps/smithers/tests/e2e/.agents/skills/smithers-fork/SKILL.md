---
name: smithers-fork
description: Create a branched run from a snapshot checkpoint (time travel). Run `smithers fork --help` for usage details.
requires_bin: smithers
command: smithers fork
---

# smithers fork

Create a branched run from a snapshot checkpoint (time travel).

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `workflow` | `string` | yes | Workflow ID (from `smithers workflow list`) or path to a .tsx workflow file |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--runId` | `string` |  | Source run ID |
| `--frame` | `number` |  | Frame number to fork from |
| `--resetNode` | `string` |  | Node ID to reset to pending |
| `--input` | `string` |  | Input overrides as JSON string |
| `--label` | `string` |  | Branch label |
| `--run` | `boolean` | `false` | Immediately start the forked run |
