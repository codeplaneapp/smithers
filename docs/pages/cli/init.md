---
description: "Run the init system flow"
---

# smithers init

Run the init system flow.

## Usage

```sh
smithers init [flags] [<key=value...>]
```

## Behavior

Scaffolds `flows/<name>/flow.mdx` and adds `.flows/` to `.gitignore`. `--global` is not supported (seats resolve from environment keys); it exits 1.

## Flags

| Flag | Meaning |
| --- | --- |
| `--data string` | See the behavior above. |

## Removed flags

These flags existed in Smithers 0.x. `smithers init` declares each one so it fails with a migration message instead of a usage error, and exits 1.

| Flag | Reason |
| --- | --- |
| `--global` | rc.0 has no global pack; seats resolve from environment keys (section 4.1) |

## Source

This page is generated from the binary's `--help` output and section 4.1 of the
[release contract](https://github.com/smithersai/smithers/blob/main/docs/migration/rc-contract.md).
Run `pnpm docs:pages` after changing either.
