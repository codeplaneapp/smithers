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

This page is generated from the binary's `--help` output and section 4.1 of the
[release contract](https://github.com/smithersai/smithers/blob/main/docs/migration/rc-contract.md).
Run `pnpm docs:pages` after changing either.
