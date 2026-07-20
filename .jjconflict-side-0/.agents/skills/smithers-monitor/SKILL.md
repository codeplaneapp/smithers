---
name: smithers-monitor
description: "Open the Smithers Monitor: a live web UI over every run in this workspace (runs, execution trees, events, approvals). Starts the workspace Gateway automatically if none is running; pass --no-autostart or --gateway <url> to opt out. Run `smithers monitor --help` for usage details."
requires_bin: smithers
command: smithers monitor
---

# smithers monitor

Open the Smithers Monitor: a live web UI over every run in this workspace (runs, execution trees, events, approvals). Starts the workspace Gateway automatically if none is running; pass --no-autostart or --gateway <url> to opt out.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | no | Focus this run when the monitor opens (deep-links ?runId=). |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--gateway` | `string` |  | Gateway base URL (default http://127.0.0.1:<port>). |
| `--port` | `number` | `7331` | Gateway port when --gateway is not set. |
| `--open` | `boolean` | `true` | Open a browser. Use --no-open to just print the URL. |
| `--autostart` | `boolean` | `true` | If no Gateway is reachable for this workspace, start one automatically. Use --no-autostart to disable. |
| `--daemon` | `boolean` | `true` | Allow a background gateway daemon. Use --no-daemon (or SMITHERS_NO_DAEMON=1) to force direct operation and never autostart one — for CI, sandboxes, and containers. |
