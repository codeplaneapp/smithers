---
description: "Run the migrate system flow"
---

# smithers migrate

Run the migrate system flow.

## Usage

```sh
smithers migrate [flags] [<key=value...>]
```

## Behavior

The reserved `system/migrate` flow id is retired so the verb does not collide with the project flow.

## Flags

| Flag | Meaning |
| --- | --- |
| `--data string` | See the behavior above. |

## Removed flags

These flags existed in Smithers 0.x. `smithers migrate` declares each one so it fails with a migration message instead of a usage error, and exits 1.

| Flag | Reason |
| --- | --- |
| `--to <backend>` | SQLite only; the 0.x database move is removed (section 2, error code `unsupported_database`) |

## Source

This page is generated from the binary's `--help` output and section 4.1 of the
[release contract](https://github.com/smithersai/smithers/blob/main/docs/migration/rc-contract.md).
Run `pnpm docs:pages` after changing either.
