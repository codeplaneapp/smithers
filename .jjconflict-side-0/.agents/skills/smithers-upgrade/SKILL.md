---
name: smithers-upgrade
description: "Run the agent-assisted Smithers upgrade workflow: fetch changelogs, upgrade with a cheap agent, and escalate to a smart agent only when needed. Run `smithers upgrade --help` for usage details."
requires_bin: smithers
command: smithers upgrade
---

# smithers upgrade

Run the agent-assisted Smithers upgrade workflow: fetch changelogs, upgrade with a cheap agent, and escalate to a smart agent only when needed.

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--interactive` | `boolean` | `false` | Force the full-screen interactive TUI monitor (TTY only). |
| `--detach` | `boolean` | `false` | Launch the upgrade workflow in the background and print the run ID. |
| `--dryRun` | `boolean` | `false` | Fetch changelogs and plan the upgrade without changing the install. |
| `--runId` | `string` |  | Explicit run ID for the upgrade workflow. |
| `--root` | `string` |  | Tool sandbox root directory. |
| `--logDir` | `string` |  | NDJSON event logs directory. |
| `--backend` | `string` |  | Storage backend for the upgrade workflow run. |
| `--authToken` | `string` |  | Bearer token passed to the interactive monitor gateway client. |
