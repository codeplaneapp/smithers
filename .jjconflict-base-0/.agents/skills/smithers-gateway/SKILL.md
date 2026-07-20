---
name: smithers-gateway
description: Serve the multi-run Gateway RPC/WS control plane for workspace run state; unlike up --serve, this is not tied to one run. `smithers gateway status|stop` manages the workspace's running singleton. Run `smithers gateway --help` for usage details.
requires_bin: smithers
command: smithers gateway
---

# smithers gateway

Serve the multi-run Gateway RPC/WS control plane for workspace run state; unlike up --serve, this is not tied to one run. `smithers gateway status|stop` manages the workspace's running singleton.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | `string` | no | Manage the workspace's singleton gateway instead of serving one: status | stop |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--host` | `string` | `127.0.0.1` | Gateway bind address |
| `--port` | `number` | `7331` | Preferred gateway port (falls back to an ephemeral port when taken; clients discover the verified URL with gateway status) |
| `--backend` | `string` |  | Storage behind this workspace Gateway; a boot/deployment choice, not a client run-lookup flag |
| `--authToken` | `string` |  | Bearer token for HTTP/WS auth (or set SMITHERS_API_KEY); required to bind a non-loopback --host |
| `--mintToken` | `boolean` | `false` | Mint a random bearer token, require it on every request, and record it only in the 0600 runtime state file |
| `--insecure` | `boolean` | `false` | Allow binding a non-loopback --host with NO auth (exposes a full-control, unauthenticated control plane — dangerous) |
| `--idleTimeout` | `number` |  | Exit after this many ms with no clients, in-flight runs, or registered schedules (0 = stay up; autostarted daemons set this automatically). Overridable via SMITHERS_GATEWAY_IDLE_MS. |
