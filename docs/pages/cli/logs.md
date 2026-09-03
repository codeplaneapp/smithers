---
description: "Read run events; --follow streams future events"
---

# smithers logs

Read run events; --follow streams future events.

## Usage

```sh
smithers logs [flags] [RUN_ID]
```

## Behavior

Transcript or raw `ControlEvent` stream. `events` is an alias of `logs --json`.

## Flags

| Flag | Meaning |
| --- | --- |
| `--follow` | See the behavior above. |

## Source

This page is generated from the binary's `--help` output. Run
`pnpm docs:pages` after changing the command.
