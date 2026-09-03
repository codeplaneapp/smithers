---
description: "Show the diagnosis card for one run, or the run listing"
---

# smithers status

Show the diagnosis card for one run, or the run listing.

## Usage

```sh
smithers status [flags] [RUN_ID]
```

## Behavior

Forensics diagnosis card for one run, or the run listing. `inspect` and `why` are aliases. A run no executor took reads a `pending` verdict saying nothing is driving it, and carries `smithers cancel RUN_ID` as its unblock line.

## Source

This page is generated from the binary's `--help` output. Run
`pnpm docs:pages` after changing the command.
