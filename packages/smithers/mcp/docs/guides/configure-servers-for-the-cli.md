---
title: "Configure servers for the CLI"
description: "Write the --mcp-config file the Smithers CLI reads, know which fields it validates, and understand when a bad entry fails."
sidebar:
  order: 7
---

The CLI composes this package behind one flag. `smthrs --mcp-config <path>`
names a file of MCP servers that the local executor connects at startup and
projects into a run's flow catalog, so a flow can call them.

`SMITHERS_MCP_CONFIG` sets the same path. The flag wins when both are present,
and omitting both configures no MCP servers.

## Install the server

Install a reviewed server version and its dependencies before supplying any
credentials. This example pins the deprecated GitHub server to `2025.4.8`;
review it for your use before running it. Use a dedicated directory, review and
retain `package.json` and `package-lock.json`, then install from that lockfile:

```bash
mkdir -p /path/to/mcp-servers
env -u GITHUB_TOKEN -u GITHUB_PERSONAL_ACCESS_TOKEN npm install --prefix /path/to/mcp-servers --package-lock-only --ignore-scripts --save-exact @modelcontextprotocol/server-github@2025.4.8
# Review the pinned package and lockfile before installing.
env -u GITHUB_TOKEN -u GITHUB_PERSONAL_ACCESS_TOKEN npm ci --prefix /path/to/mcp-servers --ignore-scripts
```

Both npm commands remove the GitHub credential variables from their environment.
Launch the installed executable directly and supply the token only in the
server's `env`. This server reads `GITHUB_PERSONAL_ACCESS_TOKEN`.

## The file

A JSON array. Each entry is structurally an `McpClient.ConnectOptions`:

```json
[
  {
    "server": "github",
    "command": "/path/to/mcp-servers/node_modules/.bin/mcp-server-github",
    "args": [],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }
  },
  {
    "server": "reports",
    "command": "node",
    "args": ["./tools/reports-server.mjs"],
    "cwd": "/srv/reports",
    "requestTimeoutMs": 30000
  }
]
```

Each server's tools arrive as flows named `mcp/<server>/<tool>`, so the `server`
value is what a model reads and what you steer a run with.

## What the flag validates

The CLI checks the shape before any layer is built, and a bad file is a usage
error naming the flag rather than a lower-level exception later:

| Field                | Requirement                       |
| -------------------- | --------------------------------- |
| `server`             | Required string.                  |
| `command`            | Required string.                  |
| `args`               | Required array of strings.        |
| `cwd`                | Optional string.                  |
| `env`                | Optional object of string values. |
| `handshakeTimeoutMs` | Optional positive integer.        |
| `requestTimeoutMs`   | Optional positive integer.        |
| `queueCapacity`      | Optional positive integer.        |
| `maxFrameBytes`      | Optional positive integer.        |

Four failures are usage errors that name the path: the file is missing, it
cannot be read, it is not valid JSON, or it is not an array of entries in that
shape.

The client's other limits (`maxOutboundFrameBytes`, `maxStderrBytes`,
`maxTools`, `maxToolNameBytes`, `maxCatalogPages`) are not checked by the flag.
They still reach the client, which validates them itself, so a bad value there
surfaces as a connect-time `protocol_error` naming the option instead of a usage
error naming the file.

## When a bad server fails

Every configured server is connected when the executor starts, because naming it
in the file is an operator opting into it. A server that fails to spawn or
refuses the handshake takes the executor down loudly rather than leaving a run
silently short of the tools it was configured to have.

That is the right trade for a configured dependency and the wrong one for an
experiment. Try a new server in a scratch config before adding it to the one a
production run uses.

## The flag does nothing under --remote

Under `--remote`, the executor is not this process's to configure, so
`--mcp-config` is meaningless. Configure MCP servers where the executor actually
runs.

## The other direction

This flag is Smithers calling somebody else's tools. The reverse, an agent such
as Claude Code driving Smithers, is the Smithers MCP server: see
[`smthrs mcp`](/cli/mcp) and
[Wire the MCP server into an agent](/pkg/cli/guides/wire-the-mcp-server). The two
share a name and nothing else.

## Next

- [Bound an untrusted server](./bound-an-untrusted-server.md): what the numeric
  fields do.
- [Select the tools a run sees](./select-the-tools-a-run-sees.md): narrowing a
  large catalog, in a composition you control.
