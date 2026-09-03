---
description: "Deny the complete serialized approval payload"
---

# smithers deny

Deny the complete serialized approval payload.

## Usage

```sh
smithers deny [flags] <approval>
```

## Behavior

Denies; a denied plan can never launch. A node-level denial restarts the run in the deciding call, and the exit code follows that run's terminal status.

## Source

This page is generated from the binary's `--help` output. Run
`pnpm docs:pages` after changing the command.
