---
description: "Deliver a durable JSON signal to a run"
---

# smithers signal

Deliver a durable JSON signal to a run.

## Usage

```sh
smithers signal [flags] RUN_ID <signal-json>
```

## Behavior

Delivers a named signal to a flow parked on `WaitFor` (section 5).

## Source

This page is generated from the binary's `--help` output. Run
`pnpm docs:pages` after changing the command.
