---
name: smithers-ps
description: List active, paused, and recently completed runs. Run `smithers ps --help` for usage details.
requires_bin: smithers
command: smithers ps
---

# smithers ps

List active, paused, and recently completed runs.

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--status` | `string` |  | Filter by status: running, waiting-approval, waiting-event, waiting-timer, paused, continued, finished, failed, cancelled |
| `--limit` | `number` | `20` | Maximum runs to return |
| `--all` | `boolean` | `false` | Include all statuses |
| `--watch` | `boolean` | `false` | Watch mode: refresh output continuously |
| `--interval` | `number` | `2` | Watch refresh interval in seconds |
