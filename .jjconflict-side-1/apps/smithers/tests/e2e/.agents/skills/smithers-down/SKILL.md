---
name: smithers-down
description: Cancel all active runs. Like 'docker compose down' for workflows. Run `smithers down --help` for usage details.
requires_bin: smithers
command: smithers down
---

# smithers down

Cancel all active runs. Like 'docker compose down' for workflows.

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--force` | `boolean` | `false` | Cancel runs even if they still appear live (default only cancels stale runs) |
