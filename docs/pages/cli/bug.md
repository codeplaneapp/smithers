---
description: "Report a bug with a run digest attached"
---

# smithers bug

Report a bug with a run digest attached.

## Usage

```sh
smithers bug [flags] [<summary...>]
```

## Behavior

Posts a report with `Control.list` and a `Control.watch` digest to `bug.smithers.sh` (`SMITHERS_BUG_ENDPOINT`).

## Flags

| Flag | Meaning |
| --- | --- |
| `--run string` | See the behavior above. |

## Source

This page is generated from the binary's `--help` output. Run
`pnpm docs:pages` after changing the command.
