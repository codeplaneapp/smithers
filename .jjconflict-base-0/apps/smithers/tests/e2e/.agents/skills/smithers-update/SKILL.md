---
name: smithers-update
description: Check for a newer Smithers release and upgrade the install (or print how). Run `smithers update --help` for usage details.
requires_bin: smithers
command: smithers update
---

# smithers update

Check for a newer Smithers release and upgrade the install (or print how).

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--check` | `boolean` | `false` | Only report current vs latest version; never upgrade |
| `--dryRun` | `boolean` | `false` | Print the upgrade command without running it |
