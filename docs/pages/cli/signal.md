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

This page is generated from the binary's `--help` output and section 4.1 of the
[release contract](https://github.com/smithersai/smithers/blob/main/docs/migration/rc-contract.md).
Run `pnpm docs:pages` after changing either.
