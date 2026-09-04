---
title: "Configure servers for the CLI"
description: "Write the --mcp-config file the Smithers CLI reads, know which fields it validates, and understand when a bad entry fails."
sidebar:
  order: 7
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/mcp/docs/guides/configure-servers-for-the-cli.md"
---

The CLI composes this package behind one flag. `smthrs --mcp-config <path>`
names a file of MCP servers that the local executor connects at startup and
projects into a run's flow catalog, so a flow can call them.

`SMITHERS_MCP_CONFIG` sets the same path. The flag wins when both are present,
and omitting both configures no MCP servers.

## The file

A JSON array. Each entry is structurally an `McpClient.ConnectOptions`:

```json
[
  {
    "server": "github",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_TOKEN": "ghp_..." }
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
[`smthrs mcp`](https://smithers.sh/docs/reference/cli/mcp/) and
[Wire the MCP server into an agent](https://cli.smithers.sh/guides/wire-the-mcp-server/). The two
share a name and nothing else.

## Next

- [Bound an untrusted server](/guides/bound-an-untrusted-server/): what the numeric
  fields do.
- [Select the tools a run sees](/guides/select-the-tools-a-run-sees/): narrowing a
  large catalog, in a composition you control.
