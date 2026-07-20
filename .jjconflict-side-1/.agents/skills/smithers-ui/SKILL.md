---
name: smithers-ui
description: Open the custom UI for a workflow run in your browser. Starts a local Gateway automatically if none is running (serving workflow-owned <UI> declarations); pass --no-autostart or --gateway <url> to opt out. Run `smithers ui --help` for usage details.
requires_bin: smithers
command: smithers ui
---

# smithers ui

Open the custom UI for a workflow run in your browser. Starts a local Gateway automatically if none is running (serving workflow-owned <UI> declarations); pass --no-autostart or --gateway <url> to opt out.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | no | Run to open. Defaults to the most recent run. |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--gateway` | `string` |  | Gateway base URL (default http://127.0.0.1:<port>). |
| `--port` | `number` | `7331` | Gateway port when --gateway is not set. |
| `--workflow` | `string` |  | Open this workflow's UI directly, skipping run lookup. |
| `--app` | `boolean` | `false` | Open the full local Smithers UI (the apps/smithers control surface) instead of a single workflow run UI. Builds the bundle on first use and serves it against the local Gateway. |
| `--appPort` | `number` | `7332` | Port to serve the full UI on (with --app). |
| `--rebuild` | `boolean` | `false` | Force a rebuild of the full UI bundle before serving (with --app). |
| `--open` | `boolean` | `true` | Open a browser. Use --no-open to just print the URL. |
| `--autostart` | `boolean` | `true` | If no Gateway is reachable on the local port, start one automatically. Use --no-autostart to disable. |
| `--daemon` | `boolean` | `true` | Allow a background gateway daemon. Use --no-daemon (or SMITHERS_NO_DAEMON=1) to force direct/embedded operation and never autostart one — for CI, sandboxes, and containers. |
