---
name: smithers-supervise
description: Watch explicitly named stale runs and auto-resume them; pass --all to opt into a workspace-wide sweep. Run `smithers supervise --help` for usage details.
requires_bin: smithers
command: smithers supervise
---

# smithers supervise

Watch explicitly named stale runs and auto-resume them; pass --all to opt into a workspace-wide sweep.

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--run` | `string` |  | Only supervise these run IDs (comma-separated) |
| `--all` | `boolean` | `false` | Explicitly supervise every eligible run in the workspace |
| `--dryRun` | `boolean` | `false` | Show which stale runs would be resumed, without acting |
| `--interval` | `string` | `10s` | Poll interval (e.g. 10s, 30s, 1m) |
| `--staleThreshold` | `string` | `30s` | Heartbeat staleness threshold before resume |
| `--maxConcurrent` | `number` | `3` | Max runs resumed per poll |
