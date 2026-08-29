---
description: "Delete terminal runs older than a threshold and compact the journal"
---

# smithers gc

Delete terminal runs older than a threshold and compact the journal.

## Usage

```sh
smithers gc [flags]
```

## Behavior

Deletes terminal runs older than the threshold with their attempts, clock, deferred, and waiting rows and time-travel archive entries, then `Journal.compact`. Automatic retention stays off by default.

## Flags

| Flag | Meaning |
| --- | --- |
| `--older-than string` | See the behavior above. |
| `--dry-run` | See the behavior above. |

## Source

This page is generated from the binary's `--help` output and section 4.1 of the
[release contract](https://github.com/smithersai/smithers/blob/main/docs/migration/rc-contract.md).
Run `pnpm docs:pages` after changing either.
