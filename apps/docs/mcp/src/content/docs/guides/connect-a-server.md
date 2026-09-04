---
title: "Connect a server"
description: "Spawn an MCP server over stdio: the command and arguments, the working directory, how env is merged rather than replaced, and which protocol revisions the handshake accepts."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/mcp/docs/guides/connect-a-server.md"
---

Use `McpClient.connect` when you want the session itself, and
`McpFlows.connected` when you want the session and its projected flows in one
step. Both take the same connection options and both require
`ChildProcessSpawner` and a `Scope`.

```ts
import { NodeServices } from "@effect/platform-node"
import * as McpClient from "@smthrs/mcp/McpClient"
import { Effect } from "effect"

const program = Effect.scoped(Effect.gen(function*() {
  const client = yield* McpClient.connect({
    server: "github",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    cwd: "/path/to/repo",
    env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN }
  })
  return client.tools.map((tool) => tool.name)
}))

await Effect.runPromise(Effect.provide(program, NodeServices.layer))
```

## Name the server

`server` is not cosmetic. It is the default flow-name prefix (`mcp/<server>`)
and it appears in every error message this package produces. Pick the name you
want a model to read, and keep it stable: changing it renames every flow the
server offers.

## Scope the connection

`connect` is a scoped effect because it owns a subprocess. Compose it once,
where the host composes its other scoped services, and let the scope's lifetime
be the session's lifetime.

Do not wrap each call in its own scope. Reconnecting per call pays the handshake
and the catalog walk every time, and it discards the snapshot the projected flow
declarations were derived from.

## Set the working directory

`cwd` is passed to the child process unchanged. A server that resolves paths
relative to its own directory needs it; most do.

## Merge, do not replace, the environment

`env` values are merged into the inherited child environment rather than
replacing it. A server spawned with a credential still receives `PATH`, `HOME`,
and everything else the parent process had, which is what makes
`command: "npx"` resolvable.

```ts
// The child gets the parent's environment plus GITHUB_TOKEN.
env: {
  GITHUB_TOKEN: "..."
}
```

There is no option to start from an empty environment. If a server must not see
a variable, remove it from the parent process before connecting.

## Know which revisions the handshake accepts

`McpClient.supportedProtocolVersions` is frozen and always proposes
`2025-06-18` first:

```ts
;["2025-06-18", "2025-03-26", "2024-11-05"]
```

The server answers with the revision it chose. Any answer outside that list
fails with `protocol_error` naming both sides, because this client decodes the
`tools/list` and `tools/call` shapes of those three revisions and cannot
honestly claim a fourth.

The server must also declare a `tools` capability in its `initialize` result. A
server that serves only resources or prompts is refused: this package projects
tools and nothing else.

## Identify yourself

Every connection discloses the frozen `McpClient.clientInfo`:

```ts
{ name: "smithers", version: "1.0.0-rc.0" }
```

It is not configurable. A server that varies its behavior by client should see
one honest answer.

## Choose the deadlines

The handshake and later tool calls have separate deadlines, because they are
different questions. `handshakeTimeoutMs` (10 seconds by default) bounds each
`initialize` and `tools/list` exchange, so a server that never answers fails
instead of hanging. `requestTimeoutMs` (120 seconds by default) bounds each
`tools/call`, where a slow answer is often a correct one.

For every other limit, see
[Bound an untrusted server](/guides/bound-an-untrusted-server/).

## Next

- [Select the tools a run sees](/guides/select-the-tools-a-run-sees/).
- [The life of a session](/concepts/the-session/): what happens after
  `connect` returns.
