---
name: smithers-hijack
description: Hand off the latest resumable agent session or conversation for a run. Run `smithers hijack --help` for usage details.
requires_bin: smithers
command: smithers hijack
---

# smithers hijack

Hand off the latest resumable agent session or conversation for a run.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | yes | Run ID whose latest agent session should be hijacked |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--target` | `string` |  | Agent engine (e.g. claude-code, codex) or node id whose session to hand off |
| `--timeoutMs` | `number` | `30000` | How long to wait for a live run to hand off |
| `--launch` | `boolean` | `true` | Open the hijacked session immediately |
