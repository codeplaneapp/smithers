---
name: smithers-supervise
description: Watch for stale running runs and auto-resume them. Run `smithers supervise --help` for usage details.
requires_bin: smithers
command: smithers supervise
---

# smithers supervise

Watch for stale running runs and auto-resume them.

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--dryRun` | `boolean` | `false` | Show which stale runs would be resumed, without acting |
| `--interval` | `string` | `10s` | Poll interval (e.g. 10s, 30s, 1m) |
| `--staleThreshold` | `string` | `30s` | Heartbeat staleness threshold before resume |
| `--maxConcurrent` | `number` | `3` | Max runs resumed per poll |
