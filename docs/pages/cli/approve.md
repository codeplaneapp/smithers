---
description: "Approve the complete serialized approval payload"
---

# smithers approve

Approve the complete serialized approval payload.

## Usage

```sh
smithers approve [flags] <approval>
```

## Behavior

Plan-level and node-level (`ask`) approvals; principal stamped server-side. A node-level decision restarts the run in the deciding call (section 5.1), and the exit code follows that run's terminal status.

## Flags

| Flag | Meaning |
| --- | --- |
| `--scope choice` | (choices: once, run, remembered) |

## Source

This page is generated from the binary's `--help` output and section 4.1 of the
[release contract](https://github.com/smithersai/smithers/blob/main/docs/migration/rc-contract.md).
Run `pnpm docs:pages` after changing either.
