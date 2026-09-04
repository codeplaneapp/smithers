---
title: "@smthrs/mcp"
description: "The Model Context Protocol client and flow adapter: connect a stdio MCP server, project its tools into a Smithers flow catalog as one flow per tool, and bound what an untrusted server may send back."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/mcp/docs/README.md"
---

`@smthrs/mcp` connects to a Model Context Protocol server and turns the tools it
offers into ordinary Smithers flows.

A remote server's tools are not a second kind of capability the harness has to
know about. `@smthrs/harness/FlowBinding`'s own contract already names this
case: "a standard filesystem flow, a memory flow, an incoming MCP tool, a
durable child agent" are all just a flow declaration plus the code that runs it.
This package is the code that runs it. `McpClient` speaks newline-delimited
JSON-RPC over a spawned server's stdio, and `McpFlows` projects the resulting
tool catalog into one `FlowBinding.Binding` per tool. A cell that reads a file
and a cell that calls an MCP tool run the identical two lines.

## This package is the client half

Smithers meets MCP in two directions, and they are separate features that share
a name:

| Direction                                   | What it is                                                                                                             | Where it lives                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A Smithers run calls somebody else's tools. | This package. It spawns the server, fetches its catalog, and projects each tool as a flow named `mcp/<server>/<tool>`. | `@smthrs/mcp`, and the CLI's `--mcp-config` flag, which composes it.                                   |
| Somebody else's agent drives Smithers.      | The Smithers MCP server, which exposes runs, approvals, and steering as MCP tools.                                     | [`smthrs mcp`](https://smithers.sh/docs/reference/cli/mcp/) and [Wire the MCP server into an agent](https://cli.smithers.sh/guides/wire-the-mcp-server/). |

If you are registering Smithers with Claude Code or Codex, you want the second
row. Everything else on this site is the first.

## Install

```bash
pnpm add @smthrs/mcp
```

For the platform services a connection needs, see
[Installation](/installation/).

## The smallest real example

Connecting owns a subprocess, so it is a scoped effect. The connection lives
exactly as long as the surrounding scope:

```ts
import { NodeServices } from "@effect/platform-node"
import * as McpFlows from "@smthrs/mcp/McpFlows"
import { Effect } from "effect"

const program = Effect.scoped(Effect.gen(function*() {
  const source = yield* McpFlows.connected({
    server: "github",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: "..." }
  })
  // source: FlowBinding.Source. Pass it to FlowBinding.catalog(...) alongside
  // StandardFlows.filesystem(...), StandardFlows.shell(...), and any other
  // source the host composes.
  return source
}))

await Effect.runPromise(Effect.provide(program, NodeServices.layer))
```

Each tool becomes a flow named `mcp/<server>/<tool>`, carrying the server's own
JSON Schema as its input document, so a caller reading `ctx.flows` sees the real
parameter shape. For a run you can watch end to end, see the
[Quickstart](/quickstart/).

## The package at a glance

The root entry point exports three namespaces, and each is also importable from
`@smthrs/mcp/<Module>`:

| Namespace   | What it is                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `McpClient` | The session: the `initialize` handshake, the tool catalog fetched at connect time, and `callTool`.                                     |
| `McpFlows`  | The adapter: a connected session's catalog as a `FlowBinding.Source`, plus the authority and effect envelope every tool flow declares. |
| `McpError`  | The one typed failure, and the seven stable codes it carries.                                                                          |

Every export, with its signature, is on the [API reference](/reference/api/).

## What this package does not do

- stdio transport only. HTTP and SSE transports are not implemented, and the
  transport interface is package-internal rather than a published extension
  point.
- Tools only. Resources, prompts, sampling, and roots are not wired up.
- One catalog fetch, at connect time. A server that later announces
  `notifications/tools/list_changed` is not re-polled; reconnect to refresh.

## Where to go next

- [Installation](/installation/): the platform services a connection needs
  and the import forms.
- [Quickstart](/quickstart/): connect to a real server, call a tool, and read
  the projected flows.
- Concepts: [a remote tool as a flow](/concepts/tools-as-flows/) and
  [the life of a session](/concepts/the-session/).
- Guides: [connect a server](/guides/connect-a-server/),
  [select the tools a run sees](/guides/select-the-tools-a-run-sees/),
  [grant authority to MCP tools](/guides/grant-authority-to-mcp-tools/),
  [handle a failed tool call](/guides/handle-a-failed-tool-call/),
  [validate structured output](/guides/validate-structured-output/),
  [bound an untrusted server](/guides/bound-an-untrusted-server/),
  [configure servers for the CLI](/guides/configure-servers-for-the-cli/),
  and [test against a server](/guides/testing/).
- [Troubleshooting](/troubleshooting/): the failures this package reports,
  what causes each one, and what to change.
