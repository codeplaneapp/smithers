---
description: "Convert a Smithers 0.x project to the 1.0 authoring model"
---

# smithers migrate

Convert a Smithers 0.x project to the 1.0 authoring model.

## Usage

```sh
smithers migrate [flags] [<path>]
```

## Behavior

The reserved `system/migrate` flow id is retired so the verb does not collide with the project flow.

## Removed flags

These flags existed in Smithers 0.x. `smithers migrate` declares each one so it fails with a migration message instead of a usage error, and exits 1.

| Flag | Reason |
| --- | --- |
| `--to &lt;backend&gt;` | SQLite only; the 0.x database move is removed |

## Source

This page is generated from the binary's `--help` output and section 4.1 of the
[release contract](https://github.com/smithersai/smithers/blob/main/docs/migration/rc-contract.md).
Run `pnpm docs:pages` after changing either.
