---
name: smithers-why
description: Explain why a run is currently blocked or paused. Run `smithers why --help` for usage details.
requires_bin: smithers
command: smithers why
---

# smithers why

Explain why a run is currently blocked or paused.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | yes | Run ID to explain |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--json` | `boolean` | `false` | Output structured JSON diagnosis |
