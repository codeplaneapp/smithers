---
description: "List durable runs"
---

# smithers ps

List durable runs.

## Usage

```sh
smithers ps [flags]
```

## Behavior

Run listing; `--status` validated against `accepted|running|parked|waiting-approval|cancelled|completed|failed`. A run left `accepted` because no executor took its launch is labelled `waitingReason: executor`.

## Flags

| Flag | Meaning |
| --- | --- |
| `--flow string` | See the behavior above. |
| `--status choice` | (choices: accepted, running, parked, waiting-approval, cancelled, completed, failed) |

## Source

This page is generated from the binary's `--help` output. Run
`pnpm docs:pages` after changing the command.
