---
description: "Report registry, database, runtime, and provider readiness"
---

# smithers doctor

Report registry, database, runtime, and provider readiness.

## Usage

```sh
smithers doctor [flags]
```

## Behavior

Reports registry discovery warnings, database paths and ladder state, Node version, `jj` on `PATH`, provider keys present, and 0.x state detected (section 6).

## Source

This page is generated from the binary's `--help` output and section 4.1 of the
[release contract](https://github.com/smithersai/smithers/blob/main/docs/migration/rc-contract.md).
Run `pnpm docs:pages` after changing either.
