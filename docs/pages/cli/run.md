---
description: "Run an approved plan payload, or resume a parked run"
---

# smithers run

Run an approved plan payload, or resume a parked run.

## Usage

```sh
smithers run [flags] <plan-payload>
```

## Forms

- `smithers run <approval-payload>`
- `smithers run --resume RUN_ID`

## Behavior

Launches an approved plan; blocks until settlement when the local process owns the executor.

## Flags

| Flag | Meaning |
| --- | --- |
| `--resume` | See the behavior above. |

## Source

This page is generated from the binary's `--help` output and section 4.1 of the
[release contract](https://github.com/smithersai/smithers/blob/main/docs/migration/rc-contract.md).
Run `pnpm docs:pages` after changing either.
