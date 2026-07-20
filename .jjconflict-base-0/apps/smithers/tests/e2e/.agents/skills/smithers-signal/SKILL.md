---
name: smithers-signal
description: Deliver a durable signal to a run waiting on <Signal> or <WaitForEvent>. Run `smithers signal --help` for usage details.
requires_bin: smithers
command: smithers signal
---

# smithers signal

Deliver a durable signal to a run waiting on <Signal> or <WaitForEvent>.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | yes | Run ID containing the waiting signal |
| `signalName` | `string` | yes | Signal name to deliver |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--data` | `string` |  | Signal payload as JSON (default: {}) |
| `--correlation` | `string` |  | Correlation ID to match a specific waiter |
| `--by` | `string` |  | Name or identifier of the signal sender |
