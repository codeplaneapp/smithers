---
name: smithers-ask-human
description: Raise a blocking human-approval request from inside a run and wait for the decision. Use when blocked, uncertain, or about to do something irreversible — never guess. Run `smithers ask-human --help` for usage details.
requires_bin: smithers
command: smithers ask-human
---

# smithers ask-human

Raise a blocking human-approval request from inside a run and wait for the decision. Use when blocked, uncertain, or about to do something irreversible — never guess.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `prompt` | `string` | yes | The decision or question to put to a human |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--context` | `string` |  | Extra context appended to the prompt |
| `--choices` | `string` |  | Comma-separated choices; makes this a fixed-choice decision |
| `--runId` | `string` |  | Run to attach to (default: SMITHERS_RUN_ID or the single active run) |
| `--node` | `string` |  | Node id to attach to (default: SMITHERS_NODE_ID or 'agent-ask') |
| `--iteration` | `number` |  | Loop iteration (default: SMITHERS_ITERATION or 0) |
| `--timeout` | `number` |  | Seconds to wait before the request expires (0/unset = no timeout) |
| `--poll` | `number` |  | Poll interval in seconds while blocking (default 3) |
