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

Run listing; `--status` validated against `accepted|running|parked|waiting-approval|cancelled|completed|failed`.

## Flags

| Flag | Meaning |
| --- | --- |
| `--flow string` | See the behavior above. |
| `--status choice` | (choices: accepted, running, parked, waiting-approval, cancelled, completed, failed) |

## Source

This page is generated from the binary's `--help` output and section 4.1 of the
[release contract](https://github.com/smithersai/smithers/blob/main/docs/migration/rc-contract.md).
Run `pnpm docs:pages` after changing either.
