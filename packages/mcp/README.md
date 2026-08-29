# @smthrs/mcp

Model Context Protocol client and flow adapter for `flows`.

A remote MCP server's tools are not a second kind of capability the harness
has to know about. `@smthrs/harness/FlowBinding`'s own contract already
names this case: "a standard filesystem flow, a memory flow, an incoming MCP
tool, a durable child agent" are all just a flow declaration plus the code
that runs it. This package is the code that runs it — a stdio JSON-RPC
client for the handshake and `tools/list`/`tools/call`, and a projector that
turns the resulting tool catalog into one `FlowBinding.Binding` per tool.

## Usage

```ts
import * as McpFlows from "@smthrs/mcp/McpFlows"
import { Effect } from "effect"

const source = yield* McpFlows.connected({
  server: "github",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"]
})
// source: FlowBinding.Source — pass it to FlowBinding.catalog(...) alongside
// StandardFlows.filesystem(...), StandardFlows.shell(...), and any other
// sources the host composes.
```

`McpFlows.connected` needs `ChildProcessSpawner` and a `Scope` in its
requirements — the same services a host already provides for
`StandardFlows.shell`. The connection's lifetime is the scope's lifetime;
closing it tears down the spawned server.

Each tool becomes a flow named `mcp/<server>/<tool>`, with the server's own
JSON Schema disclosed as the flow's input document. Capabilities and effects
are declared conservatively (`["*"]`, `tier: "irreversible"`) because an MCP
tool is opaque code this adapter does not control — the same "unprojectable
authority" fallback `@smthrs/registry/MarkdownFlow` uses for a skill with no
declared `capabilities`.

## Scope

- stdio transport only. HTTP/SSE transports are a different `Transport`
  implementation behind the same `internal/StdioTransport.Transport`-shaped
  interface, added when a server that needs one shows up.
- The tool catalog is fetched once, at connect time. A server that changes
  its tools later (`notifications/tools/list_changed`) is not re-polled;
  reconnect to refresh, the same shape `ctx.<domain>.reload()` gives every
  other transform source in this repo.
- Resources, prompts, sampling, and roots are not implemented. Add them to
  `McpClient` when a flow adapter needs them.
