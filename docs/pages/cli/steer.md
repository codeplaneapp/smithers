---
description: "Send a durable, attributed steering message to a run"
---

# smithers steer

Send a durable, attributed steering message to a run.

## Usage

```sh
smithers steer [flags] RUN_ID
```

## Behavior

Durable, attributed steer through the notification queue; drained at the agent's turn close.

## Flags

| Flag | Meaning |
| --- | --- |
| `--message string` | See the behavior above. |

## Removed flags

These flags existed in Smithers 0.x. `smithers steer` declares each one so it fails with a migration message instead of a usage error, and exits 1.

| Flag | Reason |
| --- | --- |
| `--takeover` | hijack is not available; `steer --message` is the only mode |

## Source

This page is generated from the binary's `--help` output and section 4.1 of the
[release contract](https://github.com/smithersai/smithers/blob/main/docs/migration/rc-contract.md).
Run `pnpm docs:pages` after changing either.
