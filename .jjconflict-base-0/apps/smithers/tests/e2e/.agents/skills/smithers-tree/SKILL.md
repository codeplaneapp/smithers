---
name: smithers-tree
description: Print DevTools snapshot as XML tree. Run `smithers tree --help` for usage details.
requires_bin: smithers
command: smithers tree
---

# smithers tree

Print DevTools snapshot as XML tree.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | yes | Run ID to inspect |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--frame` | `number` |  | Historical frame number |
| `--watch` | `boolean` | `false` | Stream live events |
| `--json` | `boolean` | `false` | Emit snapshot JSON |
| `--depth` | `number` |  | Truncate depth |
| `--node` | `string` |  | Scope to subtree |
| `--color` | `string` | `auto` | Colorize output |
