---
name: smithers-gui
description: "Open a directory's workspace in the Smithers UI: starts (or attaches to) the workspace Gateway and opens the MOST RECENT run's workflow UI; pass --workflow <id> to open a specific workflow UI directly. Run `smithers gui --help` for usage details."
requires_bin: smithers
command: smithers gui
---

# smithers gui

Open a directory's workspace in the Smithers UI: starts (or attaches to) the workspace Gateway and opens the MOST RECENT run's workflow UI; pass --workflow <id> to open a specific workflow UI directly.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | `string` | no | Directory path (defaults to current working directory) |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--gateway` | `string` |  | Gateway base URL (default http://127.0.0.1:<port>). |
| `--port` | `number` | `7331` | Gateway port when --gateway is not set. |
| `--workflow` | `string` |  | Open this workflow's UI directly, skipping run lookup. |
| `--open` | `boolean` | `true` | Open a browser. Use --no-open to just print the URL. |
| `--autostart` | `boolean` | `true` | If no Gateway is reachable on the local port, start one automatically. Use --no-autostart to disable. |
| `--daemon` | `boolean` | `true` | Allow a background gateway daemon. Use --no-daemon (or SMITHERS_NO_DAEMON=1) to force direct/embedded operation and never autostart one — for CI, sandboxes, and containers. |
